import { beforeEach, describe, expect, it } from "bun:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/agents";
import { createConversations, type Snapshots } from "@orqestra/conversations";
import { noMcpServerDeletes } from "@orqestra/conversations/testing";
import { db } from "@orqestra/db";
import * as schema from "@orqestra/db/schema";
import { memoryOrrery, memoryStore } from "@orqestra/tools/testing";
import { sql } from "drizzle-orm";
import { createApp } from "./app.ts";
import { createCapabilities } from "./capabilities.ts";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL (see test-env.ts), wiped before every test
const skip = !process.env.TEST_DATABASE_URL;

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const agent = {
	id: "a",
	name: "a",
	description: "test Agent",
	instructions: "",
	default: false,
	pickable: true,
	tools: [],
	skills: [],
} as AgentDefinition;
const config = {
	agents: [agent],
	models: faux.models,
	defaultAgent: agent,
	skills: {},
	sandboxProvider: { url: "http://o", token: "t", cpu: 2, memory: 2 ** 31 },
} as unknown as Snapshots;

let o = memoryOrrery();
const conversations = createConversations({
	store: memoryStore().store,
	capabilities: {
		...noMcpServerDeletes,
		current: async () => config,
		skillFiles: async () => [],
	},
	orrery: () => o.client,
});

/** The api as the given User, or signed out. */
function app(userId: string | null) {
	const api = createApp({
		config: createCapabilities(db),
		session: async () => ({
			user: userId ? { id: userId, name: userId, admin: false } : null,
			cookies: [],
		}),
		auth: () => new Response(null, { status: 404 }),
		conversations,
	});
	return (request: Request) => api.handle(request);
}

const newConversation = async () =>
	(
		await db
			.insert(schema.conversation)
			.values({ userId: "u1", agentId: "a" })
			.returning()
	)[0].id;
const upload = (
	id: string,
	body: string | ReadableStream,
	headers?: Record<string, string>,
) =>
	new Request(`http://localhost/api/conversations/${id}/uploads?name=a.txt`, {
		method: "POST",
		body,
		headers,
	});
const download = (id: string, name: string) =>
	new Request(
		`http://localhost/api/conversations/${id}/files?name=${encodeURIComponent(name)}`,
	);
const mb = new Uint8Array(1024 * 1024);

describe.skipIf(skip)("a Conversation's uploads and files", () => {
	beforeEach(async () => {
		o = memoryOrrery();
		await db.execute(sql`truncate conversation cascade`);
	});

	it("takes an upload, and serves it back from object storage without a Sandbox", async () => {
		const id = await newConversation();
		const up = await app("u1")(upload(id, "data"));
		expect(up.status).toBe(200);
		expect(await up.json()).toEqual({ name: "a.txt" });

		const down = await app("u1")(download(id, "a.txt"));
		expect(down.status).toBe(200);
		expect(await down.text()).toBe("data");
		expect(down.headers.get("content-length")).toBe("4");
		expect(o.calls).toEqual([]);
		expect(down.headers.get("content-disposition")).toBe(
			"attachment; filename*=UTF-8''a.txt",
		);
		expect(down.headers.get("content-type")).toBe("application/octet-stream");
		expect(down.headers.get("x-content-type-options")).toBe("nosniff");
		expect(down.headers.get("cache-control")).toBe("private, no-store");
	});

	it("refuses an upload whose length is over the limit before reading it", async () => {
		const id = await newConversation();
		let pulled = false;
		const body = new ReadableStream(
			{
				pull() {
					pulled = true;
				},
			},
			{ highWaterMark: 0 },
		);
		const response = await app("u1")(
			upload(id, body, { "content-length": String(51 * 1024 * 1024) }),
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			errors: { file: { code: "too_large" } },
		});
		expect(pulled).toBe(false);
		expect(o.calls).toEqual([]);
	});

	it("counts the stream of an upload whose length it is not told", async () => {
		const id = await newConversation();
		const body = new ReadableStream({
			start(c) {
				for (let i = 0; i < 51; i++) c.enqueue(mb);
				c.close();
			},
		});
		const response = await app("u1")(upload(id, body));
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			errors: { file: { code: "too_large" } },
		});
	});

	it("is 401 without a User, and 404 for another User's Conversation", async () => {
		const id = await newConversation();
		await app("u1")(upload(id, "x"));
		expect((await app(null)(upload(id, "x"))).status).toBe(401);
		expect((await app(null)(download(id, "a.txt"))).status).toBe(401);
		const up = await app("u2")(upload(id, "x"));
		expect(up.status).toBe(404);
		expect(await up.json()).toEqual({
			errors: { conversation: { code: "not_found" } },
		});
		const down = await app("u2")(download(id, "a.txt"));
		expect(down.status).toBe(404);
		expect(await down.json()).toEqual({
			errors: { file: { code: "not_found" } },
		});
		expect((await app("u1")(upload("nope", "x"))).status).toBe(404);
		expect((await app("u1")(download(id, "b.txt"))).status).toBe(404);
		expect(o.calls).toEqual([]);
	});
});
