import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/agents";
import {
	agentSessionEvent,
	fakeLinear,
	signed,
} from "@orqestra/integrations/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RunHandle, Snapshots } from "./index.ts";

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const {
	agent: agentRow,
	conversation,
	inbox,
	integrationAccount,
	integrationInstallation,
	integrationSession,
	user,
} = await import("@orqestra/db/schema");
const { encryptSecret } = await import("@orqestra/db/secret");
const { memoryStore } = await import("@orqestra/db/store");
const { webhookEvent } = await import("@orqestra/integrations");
const { linear: source } = await import("@orqestra/integrations/linear");
const { eq, sql } = await import("drizzle-orm");
const {
	createConversations,
	handleSessionEvent,
	reportingToSessions,
	reportSessionFailure,
	SpendingLimitReached,
} = await import("./index.ts");

// Linear Agent Sessions (Integration Sessions) becoming Conversations, against a migrated, throwaway Postgres (TEST_DATABASE_URL, wiped before every
// test) and the real @orqestra/conversations; Linear is a fake behind the injected fetch. No worker runs, so Runs stay queued.

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
	const event = await webhookEvent(
		source,
		body,
		new Headers({ "linear-signature": signature }),
	);
	if (!event) throw new Error("not an event Orqestra acts on");
	await handleSessionEvent(source, event, conversations, {
		fetch: linear.fetch,
		orqestraUrl: "https://orqestra.example.com",
	});
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

/** Links an Orqestra User to a Linear user, as their authorizing as themselves does. */
const link = (userId: string, externalId: string) =>
	db
		.insert(integrationAccount)
		.values({ kind: "linear", externalId, userId, name: userId });

describe.skipIf(!url)("Linear Agent Session events", () => {
	const reset = async () => {
		await db.execute(
			sql`truncate conversation, integration_installation, "user" cascade`,
		);
		await db.delete(agentRow).where(eq(agentRow.id, "coder"));
		linear = fakeLinear();
	};
	beforeEach(async () => {
		await reset();
		await db.insert(integrationInstallation).values({
			kind: "linear",
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
			scopeRepos: { ENG: "acme/web" },
		});
		linear.accessTokens.add("access-0");
		await db.insert(user).values({
			id: "u1",
			name: "Uma",
			email: "Uma@Example.com",
			lastActiveAt: new Date(),
		});
		await link("u1", "lin-user-1");
	});
	afterAll(reset);

	it("opens one Conversation for a session, as the User who linked the creator's Linear account, however often its start is delivered", async () => {
		const created = agentSessionEvent();
		await deliver(created);
		await deliver(created);
		await Promise.all([deliver(created), deliver(created)]);

		const [opened, ...others] = await conversationsOf("u1");
		expect(others).toEqual([]);
		expect(opened).toMatchObject({ agentId: "general", unattended: true });
		expect(
			await db
				.select({
					kind: integrationSession.kind,
					sessionId: integrationSession.sessionId,
					conversationId: integrationSession.conversationId,
				})
				.from(integrationSession)
				.where(eq(integrationSession.conversationId, opened.id)),
		).toEqual([
			{ kind: "linear", sessionId: "session-1", conversationId: opened.id },
		]);
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

	it("opens none when no User linked the creator's Linear account, whatever their email, and asks them to connect it", async () => {
		await deliver(agentSessionEvent({ userId: "lin-stranger" }));

		expect(await db.select().from(conversation)).toEqual([]);
		expect(await db.select().from(integrationSession)).toEqual([]);
		expect(linear.activities).toEqual([
			{
				agentSessionId: "session-1",
				content: {
					type: "elicitation",
					body: "Connect your Linear account to Orqestra first, at https://orqestra.example.com/connections, then reply here.",
				},
			},
		]);
	});

	it("opens it with the installation's default Agent", async () => {
		// the Agent's row, which the installation refers to; the snapshot has its definition
		await db.insert(agentRow).values({ id: "coder", definition: coder });
		await db.update(integrationInstallation).set({ defaultAgentId: "coder" });
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
		await link("u2", "lin-user-2");
		await deliver(
			agentSessionEvent({ prompt: "Delete it all.", userId: "lin-user-2" }),
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

	it("opens the Conversation of a session whose start found no User, once its creator has linked their account and replies", async () => {
		await db.delete(integrationAccount);
		await deliver(agentSessionEvent());
		await link("u1", "lin-user-1");
		await deliver(agentSessionEvent({ prompt: "Signed in now." }));

		const [opened] = await conversationsOf("u1");
		expect(
			(await inputsOf(opened.id))[0].text.endsWith(
				"It does nothing on Safari.\n\nSigned in now.",
			),
		).toBe(true);
		expect(linear.activities.map((a) => a.content.type)).toEqual([
			"elicitation",
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

	it("tells a session no person started that only a person can, opening nothing", async () => {
		await handleSessionEvent(
			source,
			{
				id: "created-session-1",
				sessionId: "session-1",
				action: "created",
				from: null,
				issue: null,
				scope: null,
				text: null,
				stop: false,
			},
			conversations,
			{ fetch: linear.fetch },
		);
		expect(await db.select().from(conversation)).toEqual([]);
		expect(linear.activities).toEqual([
			{
				agentSessionId: "session-1",
				content: {
					type: "error",
					body: "Only a person can start this: nobody's Orqestra account is linked to it.",
				},
			},
		]);
	});

	it("tells the session why Orqestra refused to open its Conversation, and opens none", async () => {
		// an Agent the installation picked that no Run can use
		await db.insert(agentRow).values({ id: "coder", definition: coder });
		await db.update(integrationInstallation).set({ defaultAgentId: "coder" });
		const offline = createConversations({
			capabilities: {
				current: async () =>
					({
						agents: [general],
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
		const { body, signature } = signed(agentSessionEvent(), secret);
		const event = await webhookEvent(
			source,
			body,
			new Headers({ "linear-signature": signature }),
		);
		if (!event) throw new Error("not an event Orqestra acts on");
		await handleSessionEvent(source, event, offline, { fetch: linear.fetch });

		expect(await db.select().from(conversation)).toEqual([]);
		expect(linear.activities).toEqual([
			{
				agentSessionId: "session-1",
				content: { type: "error", body: "This Agent is offline" },
			},
		]);
	});

	it("confirms a stop for a session with no Conversation", async () => {
		await deliver(agentSessionEvent({ prompt: "Stop", signal: "stop" }));
		expect(await db.select().from(conversation)).toEqual([]);
		expect(linear.activities.map((a) => a.content)).toEqual([
			{ type: "response", body: "Stopped." },
		]);
	});

	it("posts nothing for a prompt it sends to the Conversation, and sends none with no text", async () => {
		await deliver(agentSessionEvent());
		await deliver(agentSessionEvent({ prompt: "Also check Firefox." }));
		await deliver(agentSessionEvent({ prompt: "" }));

		const [opened] = await conversationsOf("u1");
		expect((await inputsOf(opened.id)).map((i) => i.text).slice(1)).toEqual([
			"Also check Firefox.",
		]);
		expect(linear.activities.map((a) => a.content.type)).toEqual(["thought"]);
	});

	describe("closing a turn", () => {
		/** The session's Conversation, opened, and the job its Run was queued as. */
		const opened = async () => {
			await deliver(agentSessionEvent());
			const [conv] = await conversationsOf("u1");
			if (!conv.jobId) throw new Error("no Run queued");
			return { id: conv.id, jobId: conv.jobId };
		};
		const replied = (conversationId: string, jobId: string, text: string) =>
			reportingToSessions(
				async (run) => {
					await run.save(fauxAssistantMessage(text));
					await run.finish();
				},
				{ fetch: linear.fetch },
			)(
				{
					conversationId,
					jobId,
					signal: new AbortController().signal,
					save: async () => {},
					finish: async () => [],
				} as unknown as RunHandle,
				undefined as never,
			);

		it("posts nothing for a stop once the Run's reply closed its turn", async () => {
			const { id, jobId } = await opened();
			await replied(id, jobId, "Done.");
			await deliver(agentSessionEvent({ prompt: "Stop", signal: "stop" }));

			expect(linear.activities.map((a) => a.content)).toEqual([
				{ type: "thought", body: "Working on this in Orqestra." },
				{ type: "response", body: "Done." },
			]);
		});

		it("posts a failure once per Run, saying so when the Spending Limit refused it, and nothing after its reply", async () => {
			const { id, jobId } = await opened();
			await reportSessionFailure(id, new SpendingLimitReached(), jobId, {
				fetch: linear.fetch,
			});
			await reportSessionFailure(id, new Error("again"), jobId, {
				fetch: linear.fetch,
			});
			await replied(id, "job-2", "Done.");
			await reportSessionFailure(id, new Error("late"), "job-2", {
				fetch: linear.fetch,
			});

			expect(linear.activities.map((a) => a.content).slice(1)).toEqual([
				{
					type: "error",
					body: "This month's Spending Limit is used up, so the request was not sent.",
				},
				{ type: "response", body: "Done." },
			]);
		});

		it("posts nothing for a Run of a Conversation of no session", async () => {
			const id = await conversations.send("u1", { text: "Hi" });
			await replied(id, "job-x", "Hello.");
			await reportSessionFailure(id, new Error("down"), "job-y", {
				fetch: linear.fetch,
			});
			expect(linear.activities).toEqual([]);
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
			await reportingToSessions(
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
