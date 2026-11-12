import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "@orqestra/agents";
import { memoryStore } from "@orqestra/tools/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OrqestraConfig, RunHandle, TaskInput } from "./index.ts";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { sql } = await import("drizzle-orm");
const { limits } = await import("@orqestra/db/schema");
const { createConversations, DEFAULT_LIMITS, TaskError } = await import(
	"./index.ts"
);
const { noMcpServerDeletes } = await import("./testing.ts");

const faux = fauxProvider({
	provider: "faux",
	models: [{ id: "faux-1", reasoning: true }, { id: "faux-2" }],
});
const agent = (id: string, over: Partial<AgentDefinition> = {}) =>
	({
		id,
		name: id,
		description: "test Agent",
		instructions: "",
		models: ["faux/faux-1", "faux/faux-2"],
		defaultModel: "faux/faux-1",
		thinking: {},
		default: id === "faux",
		memory: false,
		pickable: true,
		allModels: false,
		tools: [],
		skills: [],
		unavailableModels: [],
		...over,
	}) as AgentDefinition;
const base = {
	agents: [agent("faux"), agent("hidden", { pickable: false })],
	models: faux.models,
	defaultAgent: agent("faux"),
	skills: {},
	// every second, so a test sees Firings come
	limits: { ...DEFAULT_LIMITS, minFiringInterval: 1 },
} as unknown as OrqestraConfig;
let config = base;
const conversations = createConversations({
	store: memoryStore().store,
	capabilities: {
		...noMcpServerDeletes,
		current: async () => config,
		skillFiles: async () => [],
	},
});
const tasks = conversations.tasks;
const ada = "ada";

const input = (over: Partial<TaskInput> = {}): TaskInput => ({
	name: "News",
	prompt: "Summarize the news",
	agentId: "faux",
	model: "faux/faux-1",
	thinking: "low",
	schedule: { kind: "every", seconds: 1 },
	endsAt: null,
	timeZone: "Asia/Shanghai",
	incognito: false,
	alertOnComplete: true,
	enabled: true,
	...over,
});
const soon = (ms = 300) => new Date(Date.now() + ms).toISOString();

/** Each Run's handler; by default it replies "done" and ends. */
let handler: (run: RunHandle) => Promise<void>;
const reply = async (run: RunHandle, text = "done") => {
	await run.save(fauxAssistantMessage(text));
	await run.finish(
		run.unattended ? { outcome: "completed", result: text } : undefined,
	);
};

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 300; i++) {
		const v = await read();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}
const task = (id: string) => tasks.get(ada, id);

// Firings come every second, so a test waits several
describe.skipIf(!url)(
	"Scheduled Tasks and Firings (Postgres)",
	{ timeout: 20_000 },
	() => {
		let stopWorker: () => Promise<void>;
		beforeAll(async () => {
			stopWorker = await conversations.serveRuns((run) => handler(run));
		});
		afterAll(() => stopWorker?.());
		beforeEach(async () => {
			config = base;
			handler = (run) => reply(run);
			await db.execute(
				sql`truncate conversation, scheduled_task, limits cascade`,
			);
		});

		it("fires a one-time task into a new Conversation: the prompt as the User's message sent by the task, in an Unattended Run; then it is finished", async () => {
			const seen: Partial<RunHandle>[] = [];
			handler = async (run) => {
				const { unattended, userId, rootConversationId } = run;
				const { scheduledTaskId, firingId } = run;
				seen.push({
					unattended,
					userId,
					rootConversationId,
					scheduledTaskId,
					firingId,
				});
				await reply(run);
			};
			const id = await tasks.create(
				ada,
				input({ schedule: { kind: "once", at: soon() } }),
			);
			const done = await waitFor(
				() => task(id),
				(t) => t?.firings[0]?.outcome === "completed",
			);
			expect(done?.state).toBe("finished");
			const conversationId = done?.firings[0].conversationId as string;
			const conv = await conversations.get(ada, conversationId);
			expect(conv?.messages[0]).toMatchObject({
				message: { role: "user", content: "Summarize the news" },
				origin: "task",
			});
			expect(seen).toEqual([
				{
					unattended: true,
					userId: ada,
					rootConversationId: conversationId,
					scheduledTaskId: id,
					firingId: expect.any(Number),
				},
			]);
		});

		/** Each Run, in turn, ends as the next of these says. */
		const runs = (...steps: ("fail" | "partial" | "question" | Hold)[]) => {
			handler = async (run) => {
				const step = steps.shift() ?? "partial";
				if (typeof step === "object") await step.until();
				if (
					step === "fail" ||
					(typeof step === "object" && step.end === "fail")
				)
					throw new Error("boom");
				await run.save(fauxAssistantMessage("done"));
				if (step === "question")
					await run.finish(undefined, { question: true });
				else await run.finish({ outcome: "partial", result: "done" });
			};
		};
		type Hold = { until: () => Promise<unknown>; end: "fail" | "partial" };
		const outcomes = async (id: string) =>
			(await task(id))?.firings.map((f) => f.outcome).reverse() ?? [];

		it("skips a Firing while the previous one's Conversation is running, not while it waits on a Question; skipped ones neither count as failed nor clear the count", async () => {
			const skippedTwice = () =>
				waitFor(
					() => outcomes(id),
					(o) => o.filter((x) => x === "skipped").length === 2,
				);
			runs("question", "fail", "fail", { until: skippedTwice, end: "fail" });
			const id = await tasks.create(ada, input());
			const done = await waitFor(
				() => task(id),
				(t) => t?.state === "auto_paused",
			);
			expect(done?.firings.map((f) => f.outcome).reverse()).toEqual([
				"question",
				"failed",
				"failed",
				"failed",
				"skipped",
				"skipped",
			]);
			expect(done?.firings[0].reason).toBe("previous_running");
		});

		/** The default Spending Limit, straight into the table; null is unlimited. */
		const limitTo = async (usd: number | null) => {
			const saved = {
				...DEFAULT_LIMITS,
				spendingLimit:
					usd === null
						? { mode: "unlimited" as const }
						: { mode: "limited" as const, usd },
			};
			await db
				.insert(limits)
				.values({ id: 1, ...saved })
				.onConflictDoUpdate({ target: limits.id, set: saved });
		};

		it("skips a Firing due once its User's Spending Limit is used up, starting no Conversation; skipped ones neither count as failed nor clear the count", async () => {
			let n = 0;
			handler = async () => {
				// the second failure uses up the limit, so the Firings after it are skipped
				if (++n === 2) await limitTo(0);
				throw new Error("boom");
			};
			const id = await tasks.create(ada, input());
			const spent = (t: Awaited<ReturnType<typeof task>>) =>
				t?.firings.filter((f) => f.reason === "spending_limit") ?? [];
			const skipped = spent(
				await waitFor(
					() => task(id),
					(t) => spent(t).length === 3,
				),
			);
			expect(skipped.map((f) => [f.outcome, f.conversationId])).toEqual(
				Array(3).fill(["skipped", null]),
			);
			expect((await task(id))?.state).toBe("active");
			await limitTo(null);
			const done = await waitFor(
				() => task(id),
				(t) => t?.state === "auto_paused",
			);
			expect(done?.firings.filter((f) => f.outcome === "failed")).toHaveLength(
				3,
			);
		});

		it("auto-pauses after three failed Firings in a row; a partial or a Question clears the count", async () => {
			runs(
				"fail",
				"fail",
				"partial",
				"fail",
				"fail",
				"question",
				"fail",
				"fail",
				"fail",
			);
			const id = await tasks.create(ada, input());
			await waitFor(
				() => task(id),
				(t) => t?.state === "auto_paused",
			);
			expect(await outcomes(id)).toEqual([
				"failed",
				"failed",
				"partial",
				"failed",
				"failed",
				"question",
				"failed",
				"failed",
				"failed",
			]);
		});

		it("fails a Firing whose Agent can no longer be picked or whose Model is disabled, without a Conversation; at the third its scheduler goes", async () => {
			const id = await tasks.create(ada, input());
			config = {
				...base,
				agents: [agent("faux", { models: ["faux/faux-2"] })],
			};
			const paused = await waitFor(
				() => task(id),
				(t) => t?.state === "auto_paused",
			);
			expect(paused?.firings).toMatchObject([
				{ outcome: "failed", reason: "model_disabled", conversationId: null },
				{ outcome: "failed" },
				{ outcome: "failed" },
			]);
			config = { ...base, agents: [agent("faux", { pickable: false })] };
			await expect(tasks.setEnabled(ada, id, true)).rejects.toMatchObject({
				field: "agentId",
				code: "agent_not_pickable",
			});
			await new Promise((r) => setTimeout(r, 1500));
			expect((await task(id))?.firings).toHaveLength(3);
		});

		it("finishes a recurring task once it has run past its end, keeping its Firings", async () => {
			const id = await tasks.create(ada, input({ endsAt: soon(1500) }));
			const done = await waitFor(
				() => task(id),
				(t) => t?.state === "finished",
			);
			expect(done?.next).toBeNull();
			const fired = done?.firings.length ?? 0;
			expect(fired).toBeGreaterThan(0);
			await new Promise((r) => setTimeout(r, 1200));
			expect((await task(id))?.firings).toHaveLength(fired);
		});

		it("pauses a task, which then fires no more; an edit applies from the next Firing", async () => {
			const id = await tasks.create(ada, input());
			const first = await waitFor(
				() => task(id),
				(t) => !!t?.firings.length,
			);
			await tasks.update(ada, id, input({ prompt: "Now the weather" }));
			// one that fired meanwhile may have been skipped
			const after =
				(await task(id))?.firings[0].id ?? first?.firings[0].id ?? 0;
			const edited = await waitFor(
				() => task(id),
				(t) => !!t?.firings[0].conversationId && t.firings[0].id > after,
			);
			const latest = await conversations.get(
				ada,
				edited?.firings[0].conversationId as string,
			);
			expect(latest?.messages[0].message).toMatchObject({
				content: "Now the weather",
			});
			expect(await tasks.setEnabled(ada, id, false)).toBe(true);
			const paused = await task(id);
			expect(paused).toMatchObject({ state: "paused", next: null });
			await new Promise((r) => setTimeout(r, 1500));
			expect((await task(id))?.firings).toHaveLength(
				paused?.firings.length as number,
			);
		});

		it("keeps a Firing's Conversations out of the ordinary list until their task is deleted", async () => {
			const id = await tasks.create(
				ada,
				input({ schedule: { kind: "once", at: soon() } }),
			);
			const fired = await waitFor(
				() => task(id),
				(t) => t?.firings[0]?.outcome === "completed",
			);
			const conversationId = fired?.firings[0].conversationId;
			expect(await conversations.list(ada)).toEqual([]);
			expect((await tasks.list(ada))[0]).toMatchObject({
				unread: true,
				conversations: [{ id: conversationId, unread: true }],
			});
			await conversations.seen(ada, conversationId as string);
			expect((await tasks.list(ada))[0].unread).toBe(false);
			expect(await tasks.delete(ada, id)).toBe(true);
			expect(await task(id)).toBeUndefined();
			expect((await conversations.list(ada)).map((c) => c.id)).toEqual([
				conversationId,
			]);
		});

		it("shows a task only to the User who created it", async () => {
			const id = await tasks.create(ada, input({ enabled: false }));
			expect(await tasks.list("bob")).toEqual([]);
			expect(await tasks.get("bob", id)).toBeUndefined();
			expect(await tasks.update("bob", id, input())).toBe(false);
			expect(await tasks.setEnabled("bob", id, true)).toBe(false);
			expect(await tasks.delete("bob", id)).toBe(false);
			expect((await tasks.list(ada)).map((t) => t.id)).toEqual([id]);
		});

		it.each([
			[{ agentId: "hidden" }, "agentId", "agent_not_pickable"],
			[{ agentId: "gone" }, "agentId", "agent_not_pickable"],
			[{ model: "faux/other" }, "model", "model_unavailable"],
			// faux-2 does not reason
			[
				{ model: "faux/faux-2", thinking: "high" },
				"thinking",
				"thinking_unavailable",
			],
			[{ timeZone: "Mars/Olympus" }, "timeZone", "invalid"],
			[
				{ schedule: { kind: "once", at: "2020-01-01T00:00:00Z" } },
				"schedule.at",
				"in_past",
			],
			[
				{ schedule: { kind: "every", seconds: 3599 } },
				"schedule.seconds",
				"too_frequent",
			],
			// 09:00 and 10:00: an hour apart, then 23
			[
				{ schedule: { kind: "cron", expr: "0 9,10 * * *" } },
				"schedule.expr",
				"ok",
			],
			[
				{ schedule: { kind: "cron", expr: "30 9,10 * * *" } },
				"schedule.expr",
				"ok",
			],
			[
				{ schedule: { kind: "cron", expr: "0,30 9 * * *" } },
				"schedule.expr",
				"too_frequent",
			],
			[
				{ schedule: { kind: "cron", expr: "not cron" } },
				"schedule.expr",
				"invalid",
			],
			[{ endsAt: "2020-01-01T00:00:00Z" }, "endsAt", "in_past"],
		] as const)("refuses %j: %s %s", async (over, field, code) => {
			config = { ...base, limits: { ...DEFAULT_LIMITS } };
			const saving = tasks.create(
				ada,
				input({
					schedule: { kind: "every", seconds: 3600 },
					...over,
				} as Partial<TaskInput>),
			);
			if (code === "ok") return void (await saving);
			await expect(saving).rejects.toMatchObject({ field, code });
			await expect(saving).rejects.toBeInstanceOf(TaskError);
		});

		it("refuses a task past the User's most", async () => {
			config = {
				...base,
				limits: { ...base.limits, maxScheduledTasksPerUser: 1 },
			};
			await tasks.create(ada, input({ enabled: false }));
			await expect(tasks.create(ada, input())).rejects.toMatchObject({
				code: "too_many",
			});
			await tasks.create("bob", input({ enabled: false }));
		});
	},
);
