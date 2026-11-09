import { fauxProvider } from "@earendil-works/pi-ai";
import type { AgentDefinition, OrqestraConfig } from "@orqestra/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { createConversations, MAX_UPLOAD_BYTES } = await import("./index.ts");
const { memoryOrrery } = await import("@orqestra/tools/testing");

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const agent = (id: string, skills: string[]): AgentDefinition => ({
	id,
	name: id,
	description: "test Agent",
	instructions: "",
	models: ["faux/faux-1"],
	defaultModel: "faux/faux-1",
	thinking: {},
	default: false,
	pickable: true,
	allModels: false,
	tools: [],
	skills,
	unavailableModels: [],
});
const skilled = agent("skilled", ["pdf"]);
const config = {
	agents: [skilled, agent("plain", [])],
	models: faux.models,
	defaultAgent: skilled,
	skills: {
		pdf: { versionId: 1, description: "", disableModelInvocation: false },
	},
	sandboxProvider: { url: "http://o", token: "t", cpu: 2, memory: 2 ** 31 },
} as unknown as OrqestraConfig;

let o = memoryOrrery();
const conversations = createConversations({
	config: async () => config,
	orrery: () => o.client,
});
const userId = "u1";

const stream = (...chunks: (string | Uint8Array)[]) =>
	new ReadableStream<Uint8Array>({
		start(c) {
			for (const chunk of chunks)
				c.enqueue(
					typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
				);
			c.close();
		},
	});
const text = (bytes: Uint8Array | undefined) =>
	bytes && new TextDecoder().decode(bytes);
const newConversation = async (agentId = "skilled", owner = userId) =>
	(
		await db
			.insert(schema.conversation)
			.values({ userId: owner, agentId })
			.returning()
	)[0].id;
const upload = (
	id: string,
	name: string,
	body = stream("data"),
	user = userId,
) => conversations.upload(user, id, name, body);

describe.skipIf(!url)("Attachments (Postgres, memoryOrrery)", () => {
	// sending queues a Run: a worker that does nothing takes it (and sets up BullMQ's schema)
	let stopWorker: () => Promise<void>;
	beforeAll(async () => {
		stopWorker = await conversations.serveRuns(async () => {});
	});
	afterAll(() => stopWorker?.());
	beforeEach(async () => {
		o = memoryOrrery();
		await db.execute(sql`truncate conversation cascade`);
	});

	it("streams a file into the Conversation's Sandbox under /workspace/uploads, creating the Sandbox", async () => {
		const id = await newConversation();
		expect(await upload(id, "report.pdf", stream("he", "llo"))).toEqual({
			name: "report.pdf",
			path: "/workspace/uploads/report.pdf",
		});
		expect(text(o.files("sb1").get("uploads/report.pdf"))).toBe("hello");
	});

	it("renames a file whose name is taken instead of overwriting it", async () => {
		const id = await newConversation();
		await upload(id, "report.pdf", stream("one"));
		await upload(id, "report.pdf", stream("two"));
		const third = await upload(id, "report.pdf", stream("three"));
		expect(third?.name).toBe("report (2).pdf");
		const files = o.files("sb1");
		expect(text(files.get("uploads/report.pdf"))).toBe("one");
		expect(text(files.get("uploads/report (1).pdf"))).toBe("two");
		expect(text(files.get("uploads/report (2).pdf"))).toBe("three");
	});

	it("keeps only a safe last path segment of the name", async () => {
		const id = await newConversation();
		expect((await upload(id, "../../etc/passwd"))?.name).toBe("passwd");
		expect((await upload(id, "C:\\Users\\me\\a.txt"))?.name).toBe("a.txt");
		expect((await upload(id, "..hidden\n.txt"))?.name).toBe("hidden.txt");
		expect((await upload(id, ".."))?.name).toBe("file");
		const long = await upload(id, `${"é".repeat(300)}.txt`);
		expect(Buffer.byteLength(long?.name ?? "")).toBeLessThanOrEqual(200);
		expect(long?.name.endsWith(".txt")).toBe(true);
	});

	it("refuses a file over 50 MB while it streams, writing nothing", async () => {
		const id = await newConversation();
		const mb = new Uint8Array(1024 * 1024);
		const chunks = Array.from({ length: 51 }, () => mb);
		await expect(upload(id, "big.bin", stream(...chunks))).rejects.toThrow(
			"over 50 MB",
		);
		expect(o.files("sb1").has("uploads/big.bin")).toBe(false);
		// exactly the limit is fine
		const ok = stream(...Array.from({ length: 50 }, () => mb));
		expect((await upload(id, "ok.bin", ok))?.name).toBe("ok.bin");
		expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
	});

	it("lets only the Conversation's owner upload, and not into a Subagent's Conversation", async () => {
		const id = await newConversation();
		expect(await upload(id, "a.txt", stream("x"), "u2")).toBeUndefined();
		const [child] = await db
			.insert(schema.conversation)
			.values({ userId, agentId: "skilled", parentId: id })
			.returning();
		expect(await upload(child.id, "a.txt")).toBeUndefined();
		expect(o.calls).toEqual([]);
	});

	it("refuses uploads to an Agent without Skills", async () => {
		const id = await newConversation("plain");
		await expect(upload(id, "a.txt")).rejects.toThrow("takes no attachments");
		expect(o.calls).toEqual([]);
	});

	it("tells which Agents take attachments", async () => {
		const options = await conversations.agentOptions();
		expect(
			Object.fromEntries(options.map((a) => [a.id, a.attachments])),
		).toEqual({ skilled: true, plain: false });
	});

	it("starts an empty Conversation to upload into before its first message", async () => {
		const id = await conversations.start(userId, "skilled");
		expect((await upload(id, "a.txt"))?.name).toBe("a.txt");
		await expect(conversations.start(userId, "nobody")).rejects.toThrow();
	});

	it("puts the attachments' paths in the message for the Agent, and their names for the User", async () => {
		const id = await newConversation();
		await conversations.send(userId, {
			conversationId: id,
			text: "read these",
			attachments: ["a.txt", "b (1).pdf"],
		});
		// once the do-nothing Run has failed, the message stays put rather than moving from the Inbox
		let view = await conversations.get(userId, id);
		for (let i = 0; view?.status !== "failed" && i < 100; i++) {
			await new Promise((r) => setTimeout(r, 50));
			view = await conversations.get(userId, id);
		}
		const sent = view?.messages[0].message as unknown as {
			content: { type: string; text: string }[];
			attachments: { name: string; path: string }[];
		};
		expect(sent.content[0].text).toBe("read these");
		expect(sent.content[1].text).toContain("/workspace/uploads/a.txt");
		expect(sent.content[1].text).toContain("/workspace/uploads/b (1).pdf");
		expect(sent.attachments).toEqual([
			{ name: "a.txt", path: "/workspace/uploads/a.txt" },
			{ name: "b (1).pdf", path: "/workspace/uploads/b (1).pdf" },
		]);
		await expect(
			conversations.send(userId, {
				conversationId: id,
				text: "x",
				attachments: ["../secret"],
			}),
		).rejects.toThrow();
	});
});
