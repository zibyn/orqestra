import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { Conversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { integrationInstallation } from "@orqestra/db/schema";
import { encryptSecret } from "@orqestra/db/secret";
import { memoryStore } from "@orqestra/db/store";
import { type SessionEvent, serveEvents } from "@orqestra/integrations";
import { linear } from "@orqestra/integrations/linear";
import { agentSessionEvent, signed } from "@orqestra/integrations/testing";
import { sql } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createCapabilities } from "./capabilities.ts";

// Linear's webhook through the api, against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test.
// Nobody is signed in: Linear signs its requests instead. A worker of the test's takes what the webhook queues.
const url = process.env.TEST_DATABASE_URL;

const api = createApp({
	config: createCapabilities(db, memoryStore().store),
	session: async () => ({ user: null, cookies: [] }),
	auth: () => new Response(null, { status: 404 }),
	conversations: {} as Conversations,
});
const secret = "hook-s3cret";

const deliver = (body: string, signature?: string) =>
	api.handle(
		new Request("http://localhost/api/linear/webhook", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(signature && { "linear-signature": signature }),
			},
			body,
		}),
	);

describe.skipIf(!url)("Linear's webhook", () => {
	const queued: SessionEvent[] = [];
	let worker: Awaited<ReturnType<typeof serveEvents>>;
	beforeAll(async () => {
		worker = await serveEvents(linear, async (event) => {
			queued.push(event);
		});
	});
	const reset = () => db.execute(sql`truncate integration_installation`);
	beforeEach(async () => {
		await reset();
		queued.length = 0;
		await db.insert(integrationInstallation).values({
			kind: "linear",
			clientId: "lin-client",
			clientSecret: encryptSecret("client-s3cret"),
			webhookSecret: encryptSecret(secret),
		});
	});
	afterAll(async () => {
		await worker.close();
		await reset();
	});

	/** Waits for the worker to take `n` events, then a moment longer for any it should not get. */
	const taken = async (n: number) => {
		for (let i = 0; i < 100 && queued.length < n; i++)
			await new Promise((r) => setTimeout(r, 50));
		await new Promise((r) => setTimeout(r, 300));
		return queued;
	};

	it("answers 401 to a body not signed with the webhook secret, and queues nothing", async () => {
		const payload = agentSessionEvent({ sessionId: randomUUID() });
		const forged = signed(payload, "another-secret");
		const tampered = signed(payload, secret);
		expect((await deliver(forged.body, forged.signature)).status).toBe(401);
		expect((await deliver(forged.body)).status).toBe(401);
		expect(
			(
				await deliver(
					tampered.body.replace("Fix the login button", "Leak the secrets"),
					tampered.signature,
				)
			).status,
		).toBe(401);
		expect(await taken(0)).toEqual([]);
	});

	it("answers 401 to a signed event sent over a minute ago", async () => {
		const stale = signed(
			agentSessionEvent({
				sessionId: randomUUID(),
				webhookTimestamp: Date.now() - 61_000,
			}),
			secret,
		);
		expect((await deliver(stale.body, stale.signature)).status).toBe(401);
		expect(await taken(0)).toEqual([]);
	});

	it("answers 200 to a signed Agent Session event and queues it once, however often it is delivered", async () => {
		const sessionId = randomUUID();
		const created = signed(agentSessionEvent({ sessionId }), secret);
		const answers = await Promise.all(
			[1, 2, 3].map(() => deliver(created.body, created.signature)),
		);
		expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
		expect(await taken(1)).toEqual([
			{
				id: `created-${sessionId}`,
				sessionId,
				action: "created",
				from: { id: "lin-user-1", name: "Uma" },
				issue: {
					identifier: "ENG-7",
					title: "Fix the login button",
					description: "It does nothing on Safari.",
					url: "https://linear.app/acme/issue/ENG-7",
				},
				scope: "ENG",
				text: null,
				stop: false,
			},
		]);
	});

	it("queues a prompt with its body, and answers 200 to an event of another kind without queueing it", async () => {
		const sessionId = randomUUID();
		const prompted = signed(
			agentSessionEvent({ sessionId, prompt: "Also check Firefox." }),
			secret,
		);
		const issue = signed(
			{ type: "Issue", action: "update", webhookTimestamp: Date.now() },
			secret,
		);
		expect((await deliver(prompted.body, prompted.signature)).status).toBe(200);
		expect((await deliver(issue.body, issue.signature)).status).toBe(200);
		expect(await taken(1)).toMatchObject([
			{ action: "prompted", text: "Also check Firefox.", stop: false },
		]);
	});
});
