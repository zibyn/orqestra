import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/agents";
import { createConversations, type Snapshots } from "@orqestra/conversations";
import { noMcpServerDeletes } from "@orqestra/conversations/testing";
import { db } from "@orqestra/db";
import { memoryStore } from "@orqestra/tools/testing";
import { createApp, type User } from "./app.ts";
import { createCapabilities } from "./capabilities.ts";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL, wiped before every test (see test-env.ts)
const url = process.env.TEST_DATABASE_URL;

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const agent = (id: string, pickable = true): AgentDefinition => ({
	id,
	name: id,
	description: "test Agent",
	instructions: "",
	default: id === "faux",
	pickable,
	tools: [],
	skills: [],
});
const config = {
	agents: [agent("faux"), agent("template", false)],
	models: faux.models,
	defaultAgent: agent("faux"),
	skills: {},
} as unknown as Snapshots;
const conversations = createConversations({
	store: memoryStore().store,
	capabilities: {
		...noMcpServerDeletes,
		current: async () => config,
		skillFiles: async () => [],
	},
});

const ada: User = { id: "ada", name: "Ada", admin: false };
const bob: User = { id: "bob", name: "Bob", admin: false };

/** The app, every request signed in as user. */
function app(user: User | null) {
	const api = createApp({
		config: createCapabilities(db),
		session: async () => ({ user, cookies: [] }),
		auth: () => new Response(),
		conversations,
	});
	return async (method: string, path: string, body?: unknown) => {
		const response = await api.handle(
			new Request(`http://localhost${path}`, {
				method,
				...(body !== undefined && {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			}),
		);
		const text = await response.text();
		return {
			status: response.status,
			body: text ? JSON.parse(text) : undefined,
		};
	};
}

const notFound = { errors: { conversation: { code: "not_found" } } };

describe.skipIf(!url)("Conversations through the api", () => {
	// sending queues a Run: a worker that does nothing takes it (and sets up BullMQ's schema)
	let stopWorker: () => Promise<void>;
	beforeAll(async () => {
		stopWorker = await conversations.serveRuns(async () => {});
	});
	beforeEach(async () => {
		await db.$client.query("truncate conversation cascade");
	});
	// the shared pool stays open for the files after this one (see test-env.ts)
	afterAll(() => stopWorker?.());

	it("is 401 without a User", async () => {
		const { status, body } = await app(null)("GET", "/api/conversations");
		expect(status).toBe(401);
		expect(body).toEqual({ errors: { session: { code: "unauthorized" } } });
	});

	it("lists the User's Conversations, and only theirs", async () => {
		const id = await conversations.start(ada.id, "faux");
		await conversations.start(bob.id, "faux");
		const { status, body } = await app(ada)("GET", "/api/conversations");
		expect(status).toBe(200);
		expect(body).toEqual([
			{
				id,
				title: null,
				status: "idle",
				incognito: false,
				unread: false,
				awaitingReply: false,
				background: false,
			},
		]);
	});

	it("lists the Agents a Conversation can start with", async () => {
		const { status, body } = await app(ada)("GET", "/api/agent-options");
		expect(status).toBe(200);
		expect(body.map((a: { id: string }) => a.id)).toEqual(["faux", "template"]);
	});

	it("lists the enabled Models with their thinking levels, and the default one", async () => {
		const { status, body } = await app(ada)("GET", "/api/model-options");
		expect(status).toBe(200);
		expect(body).toEqual({
			models: [
				{
					ref: "faux/faux-1",
					name: expect.any(String),
					thinking: { allowed: ["off"], default: "off" },
				},
			],
			defaultModel: "faux/faux-1",
		});
	});

	it("starts an empty Conversation with an Agent", async () => {
		const { status, body } = await app(ada)("POST", "/api/conversations", {
			agentId: "faux",
			incognito: true,
		});
		expect(status).toBe(200);
		expect((await conversations.get(ada.id, body.id))?.incognito).toBe(true);
	});

	it("refuses an Agent that cannot be picked, by field and code", async () => {
		const { status, body } = await app(ada)("POST", "/api/conversations", {
			agentId: "template",
			incognito: false,
		});
		expect(status).toBe(422);
		expect(body).toEqual({
			errors: { agentId: { code: "agent_not_pickable" } },
		});
	});

	it("is 422 with field codes for invalid input", async () => {
		const { status, body } = await app(ada)("POST", "/api/messages", {
			text: " ",
			thinking: "loud",
		});
		expect(status).toBe(422);
		expect(Object.keys(body.errors).sort()).toEqual(["text", "thinking"]);
		expect(body.errors.text.code).toBe("invalid");
	});

	it("sends a message, starting a Conversation with the Agent, Model and thinking level", async () => {
		const send = app(ada);
		const { status, body } = await send("POST", "/api/messages", {
			agentId: "faux",
			model: "faux/faux-1",
			thinking: "off",
			text: "hello",
		});
		expect(status).toBe(200);
		const again = await send("POST", "/api/messages", {
			conversationId: body.conversationId,
			text: "again",
		});
		expect(again.body).toEqual(body);
		const { body: conversation } = await send(
			"GET",
			`/api/conversations/${body.conversationId}`,
		);
		expect(conversation.agentId).toBe("faux");
		expect(
			conversation.messages.map(
				(m: { message: { content: string } }) => m.message.content,
			),
		).toEqual(["hello", "again"]);
	});

	it("renames, stops, retries and deletes the User's Conversation", async () => {
		const id = await conversations.start(ada.id, "faux");
		const call = app(ada);
		expect(
			(await call("PATCH", `/api/conversations/${id}`, { title: "Plans" }))
				.status,
		).toBe(200);
		expect((await conversations.get(ada.id, id))?.title).toBe("Plans");
		await db.$client.query(
			"update conversation set unread = true where id = $1",
			[id],
		);
		expect((await call("POST", `/api/conversations/${id}/seen`)).status).toBe(
			200,
		);
		expect((await conversations.get(ada.id, id))?.unread).toBe(false);
		expect((await call("POST", `/api/conversations/${id}/stop`)).status).toBe(
			200,
		);
		// nothing failed yet
		expect(await call("POST", `/api/conversations/${id}/retry`)).toEqual({
			status: 422,
			body: { errors: { id: { code: "nothing_to_retry" } } },
		});
		await db.$client.query(
			"update conversation set status = 'failed' where id = $1",
			[id],
		);
		expect((await call("POST", `/api/conversations/${id}/retry`)).status).toBe(
			200,
		);
		expect((await call("DELETE", `/api/conversations/${id}`)).status).toBe(200);
		expect(await conversations.get(ada.id, id)).toBeUndefined();
	});

	it("undoes a Memory change only in the User's Conversation", async () => {
		const id = await conversations.start(ada.id, "faux");
		const { status, body } = await app(ada)(
			"POST",
			`/api/conversations/${id}/memory-undo`,
			{ toolCallId: "none" },
		);
		// no such Tool call
		expect(status).toBe(404);
		expect(body).toEqual(notFound);
	});

	it("shows and stops the User's Subagent", async () => {
		const parent = await conversations.start(ada.id, "faux");
		const {
			rows: [{ id }],
		} = await db.$client.query(
			"insert into conversation (user_id, agent_id, parent_id) values ($1, 'faux', $2) returning id",
			[ada.id, parent],
		);
		await db.$client.query(
			"insert into subagent (conversation_id, tool_call_id, number, brief) values ($1, 't1', 1, 'look')",
			[id],
		);
		const call = app(ada);
		expect(await call("GET", `/api/subagents/${id}`)).toEqual({
			status: 200,
			body: [],
		});
		expect((await call("POST", `/api/subagents/${id}/stop`)).status).toBe(200);
		const { body } = await call("GET", `/api/conversations/${parent}`);
		expect(body.subagents[0].outcome).toBe("stopped");
		// a User cannot write to a Subagent
		expect(
			(await call("POST", "/api/messages", { conversationId: id, text: "hi" }))
				.status,
		).toBe(404);
	});

	it("is 404 for another User's Conversation, whatever the action", async () => {
		const id = await conversations.start(bob.id, "faux");
		const {
			rows: [{ id: sub }],
		} = await db.$client.query(
			"insert into conversation (user_id, agent_id, parent_id) values ($1, 'faux', $2) returning id",
			[bob.id, id],
		);
		await db.$client.query(
			"insert into subagent (conversation_id, tool_call_id, number, brief) values ($1, 't1', 1, 'look')",
			[sub],
		);
		const call = app(ada);
		for (const [method, path, body] of [
			["GET", `/api/conversations/${id}`],
			["PATCH", `/api/conversations/${id}`, { title: "Mine" }],
			["DELETE", `/api/conversations/${id}`],
			["POST", `/api/conversations/${id}/stop`],
			["POST", `/api/conversations/${id}/retry`],
			["POST", `/api/conversations/${id}/seen`],
			["POST", `/api/conversations/${id}/memory-undo`, { toolCallId: "t" }],
			["DELETE", `/api/conversations/${id}/background-calls/t`],
			["POST", "/api/messages", { conversationId: id, text: "hi" }],
			["GET", `/api/subagents/${sub}`],
			["POST", `/api/subagents/${sub}/stop`],
		] as const) {
			const response = await call(method, path, body);
			expect([path, response.status]).toEqual([path, 404]);
		}
		expect((await conversations.get(bob.id, id))?.title).toBeNull();
	});
});

describe.skipIf(!url)("The Spending Limit through the api", () => {
	let stopWorker: () => Promise<void>;
	beforeAll(async () => {
		stopWorker = await conversations.serveRuns(async () => {});
	});
	beforeEach(async () => {
		await db.$client.query(
			'truncate conversation, usage, limits, "user" cascade',
		);
	});
	afterAll(() => stopWorker?.());

	/** The default limit, reset in `zone`. */
	const limitTo = (usd: number, zone = "UTC") =>
		db.$client.query(
			`insert into limits (id, max_scheduled_tasks_per_user, min_firing_interval, timer_rings_per_user_message, unattended_max_steps, unattended_max_duration, max_subagent_depth, spending_limit, reset_time_zone)
			values (1, 10, 3600, 10, 50, 1800, 2, $1, $2)`,
			[JSON.stringify({ mode: "limited", usd }), zone],
		);
	/** Ada's request at `at`, costing `cost`. */
	const spend = (cost: number, at: Date) =>
		db.$client.query(
			`insert into usage (user_id, provider, model_id, conversation_id, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost, created_at)
			values ($1, 'faux', 'faux-1', gen_random_uuid(), 'step', 1, 1, 0, 0, $2, $3)`,
			[ada.id, cost, at.toISOString().replace("Z", "")],
		);
	/** Midnight on the 1st, `months` from this month, in Shanghai: eight hours ahead of UTC all year. */
	const shanghaiFirst = (months: number) => {
		const [y, m] = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Shanghai",
			year: "numeric",
			month: "2-digit",
		})
			.format(new Date())
			.split("-")
			.map(Number);
		return new Date(Date.UTC(y, m - 1 + months, 1) - 8 * 3600_000);
	};

	it("refuses a new message once the User's limit is used up, starting no Run", async () => {
		await limitTo(5);
		await spend(5, new Date());
		const { status, body } = await app(ada)("POST", "/api/messages", {
			agentId: "faux",
			text: "hi",
		});
		expect(status).toBe(422);
		expect(body).toEqual({
			errors: { text: { code: "spending_limit_reached" } },
		});
		expect(await conversations.list(ada.id)).toEqual([]);
		// Ada's spending is not Bob's
		expect(
			(await app(bob)("POST", "/api/messages", { agentId: "faux", text: "hi" }))
				.status,
		).toBe(200);
	});

	it("tells the User where they stand this month in the reset time zone, and nothing without a limit", async () => {
		expect((await app(ada)("GET", "/api/spending-limit")).body).toEqual({
			status: null,
		});
		await limitTo(5, "Asia/Shanghai");
		const start = shanghaiFirst(0);
		// either side of this month's start in Shanghai, both in last month by UTC
		await spend(10, new Date(start.getTime() - 60_000));
		await spend(2, new Date(start.getTime() + 60_000));
		const { status, body } = await app(ada)("GET", "/api/spending-limit");
		expect(status).toBe(200);
		expect(body).toEqual({
			status: {
				spent: 2,
				usd: 5,
				reached: false,
				resetsAt: shanghaiFirst(1).toISOString(),
				resetTimeZone: "Asia/Shanghai",
			},
		});
		await spend(3, new Date());
		expect((await app(ada)("GET", "/api/spending-limit")).body.status).toEqual(
			expect.objectContaining({ spent: 5, reached: true }),
		);
	});

	it("puts a User's own setting before the default, and follows the default on `default`", async () => {
		const setting = (spendingLimit: object) =>
			db.$client.query(
				`insert into "user" (id, name, last_active_at, spending_limit) values ('ada', 'Ada', now(), $1)
				on conflict (id) do update set spending_limit = excluded.spending_limit`,
				[JSON.stringify(spendingLimit)],
			);
		const status = async () =>
			(await app(ada)("GET", "/api/spending-limit")).body.status;
		await limitTo(5);
		await spend(3, new Date());
		await setting({ mode: "limited", usd: 2 });
		expect(await status()).toMatchObject({ usd: 2, reached: true });
		await setting({ mode: "unlimited" });
		expect(await status()).toBeNull();
		await setting({ mode: "default" });
		expect(await status()).toMatchObject({ usd: 5, reached: false });
		// own setting limited while the default is unlimited
		await db.$client.query("truncate limits");
		await setting({ mode: "limited", usd: 1 });
		expect(await status()).toMatchObject({ usd: 1, reached: true });
	});
});
