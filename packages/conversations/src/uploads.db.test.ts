import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	type AgentDefinition,
	DEFAULT_LIMITS,
	type OrqestraConfig,
} from "@orqestra/config";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { RunHandler } from "./index.ts";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const { createConversations, MAX_UPLOAD_BYTES } = await import("./index.ts");
const { memoryOrrery, memoryStore } = await import("@orqestra/tools/testing");

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
	memory: false,
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
	limits: { ...DEFAULT_LIMITS },
} as unknown as OrqestraConfig;

let o = memoryOrrery();
const s = memoryStore();
const conversations = createConversations({
	config: async () => config,
	skillFiles: async () => [],
	orrery: () => o.client,
	store: s.store,
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
const stored = () => [...s.objects.values()].map(text).sort();
const withoutSandbox = async (f: () => Promise<void>) => {
	const { sandboxProvider } = config;
	config.sandboxProvider = undefined;
	try {
		await f();
	} finally {
		config.sandboxProvider = sandboxProvider;
	}
};
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

describe.skipIf(!url)(
	"Attachments (Postgres, memoryStore, memoryOrrery)",
	() => {
		// sending queues a Run: a worker that does nothing takes it (and sets up BullMQ's schema)
		let stopWorker: () => Promise<void>;
		let handler: RunHandler = async () => {};
		beforeAll(async () => {
			stopWorker = await conversations.serveRuns((...args) => handler(...args));
		});
		afterAll(() => stopWorker?.());
		beforeEach(async () => {
			handler = async () => {};
			o = memoryOrrery();
			s.objects.clear();
			await db.execute(sql`truncate conversation cascade`);
		});

		/** Sends `names` and waits for the do-nothing Run to fail, so the message stays put rather than moving from the Inbox. */
		const sendWith = async (id: string, names: string[]) => {
			await conversations.send(userId, {
				conversationId: id,
				text: "read these",
				attachments: names,
			});
			let view = await conversations.get(userId, id);
			for (let i = 0; view?.status !== "failed" && i < 100; i++) {
				await new Promise((r) => setTimeout(r, 50));
				view = await conversations.get(userId, id);
			}
			return view?.messages.at(-1)?.message as unknown as {
				content: { type: string; text: string }[];
				attachments: { name: string; path: string }[];
			};
		};

		it("keeps an upload in object storage without a Sandbox Provider", async () => {
			await withoutSandbox(async () => {
				const id = await newConversation();
				expect(await upload(id, "report.pdf", stream("he", "llo"))).toEqual({
					name: "report.pdf",
				});
				expect(stored()).toEqual(["hello"]);
			});
		});

		it("creates and wakes no Sandbox to upload", async () => {
			const id = await newConversation();
			await upload(id, "report.pdf");
			expect(o.calls).toEqual([]);
			expect(stored()).toEqual(["data"]);
		});

		it("renames a file whose name is taken instead of overwriting it, uploads at once included", async () => {
			const id = await newConversation();
			await upload(id, "report.pdf", stream("one"));
			await upload(id, "report.pdf", stream("two"));
			const third = await upload(id, "report.pdf", stream("three"));
			expect(third?.name).toBe("report (2).pdf");
			const together = await Promise.all(
				["a", "b", "c"].map((x) => upload(id, "same.txt", stream(x))),
			);
			expect(new Set(together.map((f) => f?.name)).size).toBe(3);
			await sendWith(id, ["report.pdf", "report (1).pdf", "report (2).pdf"]);
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

		it("refuses a file over 50 MB while it streams, keeping nothing", async () => {
			const id = await newConversation();
			const mb = new Uint8Array(1024 * 1024);
			const chunks = Array.from({ length: 51 }, () => mb);
			await expect(upload(id, "big.bin", stream(...chunks))).rejects.toThrow(
				"over 50 MB",
			);
			expect(s.objects.size).toBe(0);
			// exactly the limit is fine, and the refused one left its name free
			const ok = stream(...Array.from({ length: 50 }, () => mb));
			expect((await upload(id, "big.bin", ok))?.name).toBe("big.bin");
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
			expect(s.objects.size).toBe(0);
		});

		it("starts an empty Conversation to upload into before its first message", async () => {
			const id = await conversations.start(userId, "skilled");
			expect((await upload(id, "a.txt"))?.name).toBe("a.txt");
			await expect(conversations.start(userId, "nobody")).rejects.toThrow();
		});

		it("copies the attachments into the Sandbox as the message is sent, giving the Agent their paths and the User their names", async () => {
			const id = await newConversation();
			await upload(id, "a.txt", stream("A"));
			await upload(id, "b (1).pdf", stream("B"));
			const sent = await sendWith(id, ["a.txt", "b (1).pdf"]);
			expect(text(o.files("sb1").get("uploads/a.txt"))).toBe("A");
			expect(text(o.files("sb1").get("uploads/b (1).pdf"))).toBe("B");
			expect(sent.content[0].text).toBe("read these");
			expect(sent.content[1].text).toContain("/workspace/uploads/a.txt");
			expect(sent.content[1].text).toContain("/workspace/uploads/b (1).pdf");
			expect(sent.attachments).toEqual([
				{ name: "a.txt", path: "/workspace/uploads/a.txt" },
				{ name: "b (1).pdf", path: "/workspace/uploads/b (1).pdf" },
			]);
			for (const attachments of [["../secret"], ["never-uploaded.txt"]])
				await expect(
					conversations.send(userId, {
						conversationId: id,
						text: "x",
						attachments,
					}),
				).rejects.toThrow("Not an attachment");
		});

		it("deletes a Conversation's Attachments with it, its Subagents' included", async () => {
			const id = await newConversation();
			const other = await newConversation();
			await upload(id, "a.txt", stream("mine"));
			await upload(other, "b.txt", stream("other"));
			// a Subagent's, as `attach` keeps one
			const [sub] = await db
				.insert(schema.conversation)
				.values({ userId, agentId: null, parentId: id })
				.returning();
			s.objects.set(`${id}/${sub.id}/x`, new TextEncoder().encode("sub"));
			await db.insert(schema.attachment).values({
				conversationId: sub.id,
				name: "c.txt",
				size: 3,
				key: `${id}/${sub.id}/x`,
				sent: true,
			});
			expect(await conversations.delete(userId, id)).toBe(true);
			expect(stored()).toEqual(["other"]);
		});

		it("deletes, on retry, the files the withdrawn reply attached, and keeps the User's for the retry", async () => {
			const id = await newConversation();
			await upload(id, "mine.txt", stream("mine"));
			// the reply attaches a file, as the `attach` Tool does, then fails
			handler = async (run) => {
				const { name, size } = await run.attach("out.txt", stream("out"));
				const asked = fauxAssistantMessage([
					fauxToolCall("attach", { path: "out.txt" }),
				]);
				await run.save(asked);
				await run.save({
					role: "toolResult",
					toolCallId: (asked.content[0] as ToolCall).id,
					toolName: "attach",
					content: [{ type: "text", text: "Attached." }],
					details: { attachment: { path: "/workspace/out.txt", name, size } },
					isError: false,
					timestamp: Date.now(),
				});
				throw new Error("boom");
			};
			await sendWith(id, ["mine.txt"]);
			expect(stored()).toEqual(["mine", "out"]);
			let retried: unknown[] | undefined;
			handler = async (run) => {
				retried = run.transcript.messages.map((m) => m.message);
			};
			expect(await conversations.retry(userId, id)).toBe(true);
			expect(stored()).toEqual(["mine"]);
			for (let i = 0; !retried && i < 100; i++)
				await new Promise((r) => setTimeout(r, 50));
			expect(retried).toEqual([
				expect.objectContaining({
					role: "user",
					attachments: [expect.objectContaining({ name: "mine.txt" })],
				}),
			]);
			const got = await conversations.openFile(userId, id, "mine.txt");
			if (!("file" in got)) throw new Error(got.error);
			expect(await new Response(got.file.body).text()).toBe("mine");
		});

		it("sweeps uploads not sent with a message within a day, and nothing sent", async () => {
			const id = await newConversation();
			await upload(id, "sent.txt", stream("sent"));
			await upload(id, "unsent.txt", stream("unsent"));
			await sendWith(id, ["sent.txt"]);
			await conversations.sweepUploads();
			expect(stored()).toEqual(["sent", "unsent"]);
			await conversations.sweepUploads(new Date(Date.now() + 25 * 3600_000));
			expect(stored()).toEqual(["sent"]);
			await expect(
				conversations.send(userId, {
					conversationId: id,
					text: "x",
					attachments: ["unsent.txt"],
				}),
			).rejects.toThrow("Not an attachment");
		});

		it("deletes the Conversation when its Attachments cannot be deleted, and logs them", async () => {
			const id = await newConversation();
			await upload(id, "a.txt");
			const { deletePrefix } = s.store;
			s.store.deletePrefix = async () => {
				throw new Error("storage down");
			};
			const log = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				expect(await conversations.delete(userId, id)).toBe(true);
				expect(await conversations.get(userId, id)).toBeUndefined();
				expect(log).toHaveBeenCalled();
			} finally {
				s.store.deletePrefix = deletePrefix;
				log.mockRestore();
			}
		});

		it("tells an Agent without a Sandbox that Parse reads the attachments", async () => {
			await withoutSandbox(async () => {
				const id = await newConversation("plain");
				await upload(id, "a.pdf");
				const sent = await sendWith(id, ["a.pdf"]);
				expect(sent.content[1].text).toContain("Parse");
				expect(sent.content[1].text).toContain("a.pdf");
				expect(o.calls).toEqual([]);
			});
		});

		it("lets the Run find its Conversation's Attachments by name, for Parse", async () => {
			const id = await newConversation("plain");
			await upload(id, "a.pdf", stream("pdf bytes"));
			let found: Promise<unknown[]> | undefined;
			handler = async (run) => {
				found ??= Promise.all([
					run.attachment("a.pdf").then(async (a) => {
						const object = a && (await s.store.get(a.key));
						return object && new Response(object.body).text();
					}),
					run.attachment("b.pdf"),
				]);
			};
			await sendWith(id, ["a.pdf"]);
			expect(await found).toEqual(["pdf bytes", undefined]);
		});
	},
);
