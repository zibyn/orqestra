import { beforeEach, describe, expect, it } from "bun:test";
import { memoryStore } from "@orqestra/tools/testing";
import type { Session } from "./app.ts";

// GET /api/conversations/:id/events against the real @orqestra/conversations: needs TEST_DATABASE_URL, which src/test-env.ts sets up
const url = process.env.TEST_DATABASE_URL;
const { db } = await import("@orqestra/db");
const { conversation } = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { skillFiles } = await import("@orqestra/skills");
const { createCapabilities, createConversations } = await import(
	"@orqestra/conversations"
);
const config = createCapabilities(db);
const { createApp } = await import("./app.ts");

const ada = { id: "ada", name: "Ada", admin: false };
const conversations = createConversations({
	store: memoryStore().store,
	config: config.current,
	skillFiles: (versionId) => skillFiles(db, versionId),
	mcpServers: config.mcpServers,
	agents: config.agents,
});

function app(user: typeof ada | null, cookies: string[] = []) {
	const session: Session = async () => ({ user, cookies });
	const api = createApp({
		config: config,
		session,
		auth: () => new Response(null, { status: 404 }),
		conversations,
	});
	return (request: Request) => api.handle(request);
}

const events = (id: string, signal?: AbortSignal) =>
	new Request(`http://localhost/api/conversations/${id}/events`, { signal });

describe.skipIf(!url)("/api/conversations/:id/events", () => {
	beforeEach(() => db.execute(sql`truncate conversation cascade`));

	const create = async (userId: string) => {
		const [row] = await db
			.insert(conversation)
			.values({ userId })
			.returning({ id: conversation.id });
		return row.id;
	};

	it("streams the Conversation's events until the request is aborted", async () => {
		const id = await create(ada.id);
		const abort = new AbortController();
		const response = await app(ada, ["polaris.session=r; Path=/"])(
			events(id, abort.signal),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get("x-accel-buffering")).toBe("no");
		// a refresh during the request still reaches the browser
		expect(response.headers.getSetCookie()).toEqual([
			"polaris.session=r; Path=/",
		]);
		const reader = (response.body as ReadableStream<Uint8Array>).getReader();
		await db.execute(
			sql`select pg_notify(${`conversation_${id}`}, ${JSON.stringify({ type: "saved" })})`,
		);
		const { value } = await reader.read();
		expect(new TextDecoder().decode(value)).toBe('data: {"type":"saved"}\n\n');
		abort.abort();
		expect((await reader.read()).done).toBe(true);
	});

	it("is 401 without a User", async () => {
		const id = await create(ada.id);
		expect((await app(null)(events(id))).status).toBe(401);
	});

	it("is 404 for another User's Conversation or a malformed id", async () => {
		const id = await create("grace");
		for (const path of [id, "not-a-uuid"])
			expect((await app(ada)(events(path))).status).toBe(404);
	});
});
