import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/agents";
import {
	createConversations,
	type RunHandle,
	type Snapshots,
} from "@orqestra/conversations";
import { db } from "@orqestra/db";
import {
	agent as agentRow,
	conversation,
	inbox,
	linearInstallation,
	linearSession,
	user,
} from "@orqestra/db/schema";
import { encryptSecret } from "@orqestra/db/secret";
import { memoryStore } from "@orqestra/db/store";
import { linearWebhookEvent } from "@orqestra/linear/events";
import {
	agentSessionEvent,
	fakeLinear,
	signed,
} from "@orqestra/linear/testing";
import { eq, sql } from "drizzle-orm";
import { handleLinearEvent, reportingToLinear } from "./linear.ts";

// Linear Agent Session events becoming Conversations, against a migrated, throwaway Postgres (TEST_DATABASE_URL, wiped before every
// test) and the real @orqestra/conversations; Linear is a fake behind the injected fetch. No worker runs, so Runs stay queued.
const url = process.env.TEST_DATABASE_URL;

const agent = (id: string): AgentDefinition => ({
	id,
	name: id,
	description: "test Agent",
	instructions: "",
	default: false,
	pickable: true,
	tools: [],
	skills: [],
});
const general = agent("general");
const coder = agent("coder");
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const conversations = createConversations({
	capabilities: {
		current: async () =>
			({
				agents: [general, coder],
				defaultAgent: general,
				models: faux.models,
				skills: {},
				tools: {},
			}) as unknown as Snapshots,
		skillFiles: async () => [],
		mcpServers: { write: async () => [] as never },
		agents: { forget: async () => {} },
	},
	store: memoryStore().store,
});

const secret = "hook-s3cret";
let linear = fakeLinear();
/** Delivers an event as Linear's webhook would, through its signature check. */
async function deliver(payload: ReturnType<typeof agentSessionEvent>) {
	const { body, signature } = signed(payload, secret);
	const event = await linearWebhookEvent(body, signature);
	if (!event) throw new Error("not an event Orqestra acts on");
	await handleLinearEvent(event, conversations, { fetch: linear.fetch });
}

const conversationsOf = (userId: string) =>
	db.select().from(conversation).where(eq(conversation.userId, userId));
const inputsOf = async (conversationId: string) =>
	(
		await db
			.select({ message: inbox.message, origin: inbox.origin })
			.from(inbox)
			.where(eq(inbox.conversationId, conversationId))
			.orderBy(inbox.id)
	).map((i) => ({
		text: (i.message as { content: string }).content,
		origin: i.origin,
	}));

describe.skipIf(!url)("Linear Agent Session events", () => {
	const reset = async () => {
		await db.execute(
			sql`truncate conversation, linear_installation, "user" cascade`,
		);
		await db.delete(agentRow).where(eq(agentRow.id, "coder"));
		linear = fakeLinear();
	};
	beforeEach(async () => {
		await reset();
		await db.insert(linearInstallation).values({
			clientId: "lin-client",
			clientSecret: encryptSecret(linear.clientSecret),
			webhookSecret: encryptSecret(secret),
			tokens: encryptSecret(
				JSON.stringify({
					accessToken: "access-0",
					refreshToken: "refresh-0",
					expiresAt: Date.now() + 3_600_000,
				}),
			),
			workspace: "Acme",
			defaultAgentId: null,
			teamRepos: { ENG: "acme/web" },
		});
		linear.accessTokens.add("access-0");
		await db.insert(user).values({
			id: "u1",
			name: "Uma",
			email: "Uma@Example.com",
			lastActiveAt: new Date(),
		});
	});
	afterAll(reset);

	it("opens one Conversation for a session, as the User with the creator's email, however often its start is delivered", async () => {
		const created = agentSessionEvent({ email: "uma@example.com" });
		await deliver(created);
		await deliver(created);
		await Promise.all([deliver(created), deliver(created)]);

		const [opened, ...others] = await conversationsOf("u1");
		expect(others).toEqual([]);
		expect(opened).toMatchObject({ agentId: "general", unattended: true });
		expect(
			await db
				.select({
					agentSessionId: linearSession.agentSessionId,
					conversationId: linearSession.conversationId,
				})
				.from(linearSession)
				.where(eq(linearSession.conversationId, opened.id)),
		).toEqual([{ agentSessionId: "session-1", conversationId: opened.id }]);
		expect(await inputsOf(opened.id)).toEqual([
			{
				text: "Linear issue ENG-7: Fix the login button\nhttps://linear.app/acme/issue/ENG-7\n\nRepository: acme/web\n\nIt does nothing on Safari.",
				origin: "linear",
			},
		]);
		expect(linear.activities[0]).toEqual({
			agentSessionId: "session-1",
			content: { type: "thought", body: "Working on this in Orqestra." },
		});
		expect(new Set(linear.activities.map((a) => a.content.type))).toEqual(
			new Set(["thought"]),
		);
	});

	it("opens none when no User has the creator's email, and tells the session to sign in first", async () => {
		await deliver(agentSessionEvent({ email: "stranger@example.com" }));

		expect(await db.select().from(conversation)).toEqual([]);
		expect(await db.select().from(linearSession)).toEqual([]);
		expect(linear.activities).toEqual([
			{
				agentSessionId: "session-1",
				content: {
					type: "error",
					body: "Sign in to Orqestra as stranger@example.com first, then reply here.",
				},
			},
		]);
	});

	it("opens it with the installation's default Agent", async () => {
		// the Agent's row, which the installation refers to; the snapshot has its definition
		await db.insert(agentRow).values({ id: "coder", definition: coder });
		await db.update(linearInstallation).set({ defaultAgentId: "coder" });
		await deliver(agentSessionEvent());
		expect((await conversationsOf("u1"))[0].agentId).toBe("coder");
	});

	it("sends a prompt in the session to its Conversation, and only its User's", async () => {
		await deliver(agentSessionEvent());
		await deliver(agentSessionEvent({ prompt: "Also check Firefox." }));
		await db.insert(user).values({
			id: "u2",
			name: "Ugo",
			email: "ugo@example.com",
			lastActiveAt: new Date(),
		});
		await deliver(
			agentSessionEvent({ prompt: "Delete it all.", email: "ugo@example.com" }),
		);

		const [opened, ...others] = await conversationsOf("u1");
		expect(others).toEqual([]);
		expect((await inputsOf(opened.id)).slice(1)).toEqual([
			{ text: "Also check Firefox.", origin: "linear" },
		]);
		expect(await conversationsOf("u2")).toEqual([]);
		expect(linear.activities.at(-1)?.content).toEqual({
			type: "error",
			body: "Only the person who started this session can direct it.",
		});
	});

	it("opens the Conversation of a session whose start found no User, once its creator has signed in and replies", async () => {
		await db.update(user).set({ email: "later@example.com" });
		await deliver(agentSessionEvent());
		await db.update(user).set({ email: "uma@example.com" });
		await deliver(agentSessionEvent({ prompt: "Signed in now." }));

		const [opened] = await conversationsOf("u1");
		expect((await inputsOf(opened.id))[0].text).toEndWith(
			"It does nothing on Safari.\n\nSigned in now.",
		);
		expect(linear.activities.map((a) => a.content.type)).toEqual([
			"error",
			"thought",
		]);
	});

	it("stops the session's Conversation on a stop request rather than sending it, and confirms it in the session", async () => {
		await deliver(agentSessionEvent());
		await deliver(agentSessionEvent({ prompt: "Stop", signal: "stop" }));

		const [stopped] = await conversationsOf("u1");
		expect(stopped.status).toBe("idle");
		// the first message, delivered or not, and no other
		const [{ inputs }] = await db
			.execute<{ inputs: number }>(
				sql`select (select count(*) from message where conversation_id = ${stopped.id}) + (select count(*) from inbox where conversation_id = ${stopped.id}) as inputs`,
			)
			.then((r) => r.rows);
		expect(Number(inputs)).toBe(1);
		expect(linear.activities.at(-1)?.content).toEqual({
			type: "response",
			body: "Stopped.",
		});
	});

	it("cuts a reply longer than Linear takes to its 250,000 characters, saying so", async () => {
		await deliver(agentSessionEvent());
		const [opened] = await conversationsOf("u1");
		// the Run's handle as far as the reply uses it
		const run = {
			conversationId: opened.id,
			signal: new AbortController().signal,
			save: async () => {},
			finish: async () => [],
		} as unknown as RunHandle;
		// cut at either parity, so one of them between the halves of a surrogate pair
		for (const long of ["😀".repeat(130_000), `x${"😀".repeat(130_000)}`]) {
			await reportingToLinear(
				async (run) => {
					await run.save(fauxAssistantMessage(long));
					await run.finish();
				},
				{ fetch: linear.fetch },
				// each its own Run, whose turn it closes
			)({ ...run, jobId: `run-${long.length}` }, undefined as never);

			const { type, body = "" } = linear.activities.at(-1)?.content ?? {};
			expect(type).toBe("response");
			expect(body.length).toBeLessThanOrEqual(250_000);
			expect(body.length).toBeGreaterThan(249_000);
			// a lone half of a surrogate pair throws
			expect(() => encodeURIComponent(body)).not.toThrow();
			const [kept, marker] = body.split("\n\n[Cut short");
			expect(long.startsWith(kept)).toBe(true);
			expect(marker).toBe(
				": longer than Linear shows. The whole of it is in the Conversation in Orqestra.]",
			);
		}
	});
});
