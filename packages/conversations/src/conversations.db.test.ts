import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Message,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	type AgentDefinition,
	DEFAULT_LIMITS,
	GENERAL_WORKER,
	messageText,
	type OrqestraConfig,
} from "@orqestra/config";
import { createPostgresBackend, Worker } from "bullmq";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { ConversationEvent, RunHandle } from "./index.ts";

// Needs a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const schema = await import("@orqestra/db/schema");
const { sql } = await import("drizzle-orm");
const {
	BudgetExceeded,
	createConversations,
	MAX_SUBAGENTS,
	RunTimedOut,
	MAX_SUBAGENTS_PER_USER_MESSAGE,
	userMemories,
} = await import("./index.ts");
const runs = await import("./runs.ts");
const timers = await import("./timers.ts");
const { memoryRun } = await import("./testing.ts");
const { memoryOrrery, memoryStore } = await import("@orqestra/tools/testing");
const provider = { url: "http://o", token: "t", cpu: 2, memory: 2 ** 31 };

// Models only for the Turn: the scripted handler below replies in their place
const faux = fauxProvider({
	provider: "faux",
	models: [
		{ id: "faux-1", reasoning: true },
		{ id: "faux-small", contextWindow: 2000 },
	],
});
const agent = (id: string, model: string): AgentDefinition => ({
	id,
	name: id,
	description: "test Agent",
	instructions: id === "faux" ? "You are a test." : "",
	models: [model],
	defaultModel: model,
	thinking: {},
	default: false,
	memory: false,
	pickable: true,
	allModels: false,
	tools: ["search", "scrape"],
	skills: [],
	unavailableModels: [],
});
const fauxAgent = agent("faux", "faux/faux-1");
const skilled = {
	...agent("skilled", "faux/faux-1"),
	skills: ["pdf", "manual", "gone"],
};
const config = {
	agents: [fauxAgent, agent("small", "faux/faux-small"), skilled],
	models: faux.models,
	defaultAgent: fauxAgent,
	// `gone` is listed by `skilled` but disabled or deleted, so it is missing here
	skills: {
		pdf: { versionId: 1, description: "PDFs", disableModelInvocation: false },
		manual: {
			versionId: 2,
			description: "By hand",
			disableModelInvocation: true,
		},
	},
	sandboxProvider: provider,
	limits: { ...DEFAULT_LIMITS },
} as unknown as OrqestraConfig;
/** Each Skill version's SKILL.md, as the test has it now. */
const skillMds = new Map<number, string>();
const conversations = createConversations({
	store: memoryStore().store,
	config: async () => config,
	skillFiles: async (versionId) => [
		{ path: "scripts/run.py", content: new TextEncoder().encode("print()") },
		{
			path: "SKILL.md",
			content: new TextEncoder().encode(skillMds.get(versionId) ?? ""),
		},
	],
});
const userId = "u1";
// one that deletes Sandboxes in `o`
const sandboxed = (o: ReturnType<typeof memoryOrrery>) =>
	createConversations({
		store: memoryStore().store,
		config: async () => ({ ...config, sandboxProvider: provider }),
		skillFiles: async () => [],
		orrery: () => o.client,
	});

// Reads SSE events from a stream until `until` returns true
async function collect(
	stream: ReadableStream,
	until: (events: ConversationEvent[]) => boolean,
	onEvent?: (event: ConversationEvent) => void,
) {
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	const events: ConversationEvent[] = [];
	let buffer = "";
	while (!until(events)) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += value;
		const frames = buffer.split("\n\n");
		buffer = frames.pop() ?? "";
		for (const frame of frames) {
			const data = frame.match(/^data: (.*)$/m)?.[1];
			if (!data) continue;
			const event = JSON.parse(data) as ConversationEvent;
			events.push(event);
			onEvent?.(event);
		}
	}
	await reader.cancel();
	return events;
}

/**
 * The scripted handler: each step stands for one model request of a Run, and returns the reply's text or the Tool calls it makes.
 * Tool calls go through `run`, their results are saved, and inputs delivered after them, as the runtime does.
 */
type Ctx = { run: RunHandle; seen: Message[]; toolCallId: string };
type Call = { name: string; run: (ctx: Ctx) => Promise<string> };
/** A reply that asks the User a Question, as `ask_user` does: the Run ends with it. */
type Ask = { question: string };
type Step = (
	ctx: Ctx,
) => string | Call[] | Ask | Promise<string | Call[] | Ask>;

let queues: { parent: Step[]; sub: Step[]; deep: Step[] } = {
	parent: [],
	sub: [],
	deep: [],
};
/**
 * Subagents run alongside their parent, so each Run takes the next step meant for whoever runs it:
 * `sub` for Subagents that may start Subagents of their own, `deep` for those at the deepest level.
 */
function script(steps: { parent: Step[]; sub?: Step[]; deep?: Step[] }) {
	queues = {
		parent: [...steps.parent],
		sub: [...(steps.sub ?? [])],
		deep: [...(steps.deep ?? [])],
	};
}
/** A handler that replaces the script for one test. */
let override: ((run: RunHandle) => Promise<void>) | undefined;

async function scripted(run: RunHandle) {
	if (override) return override(run);
	const seen = run.transcript.messages.map((m) => m.message);
	for (;;) {
		const step = (
			!run.isSubagent ? queues.parent : run.subagents ? queues.sub : queues.deep
		).shift();
		if (!step) throw new Error("No scripted step left");
		const reply = await step({ run, seen, toolCallId: "" });
		if (typeof reply === "object" && "question" in reply) {
			const asked = fauxAssistantMessage([
				fauxToolCall("ask_user", { question: reply.question }),
			]);
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: (asked.content[0] as ToolCall).id,
				toolName: "ask_user",
				content: [{ type: "text", text: "Asked." }],
				isError: false,
				timestamp: Date.now(),
			};
			seen.push(asked, result);
			await run.save(asked);
			await run.save(result);
			const next = await run.finish(undefined, { question: true });
			if (!next.length) return;
			seen.push(...next);
			continue;
		}
		if (typeof reply === "string") {
			const answer = fauxAssistantMessage(reply);
			seen.push(answer);
			await run.save(answer);
			const next = await run.finish(
				run.isSubagent ? { outcome: "completed", result: reply } : undefined,
			);
			if (!next.length) return;
			seen.push(...next);
			continue;
		}
		const asked = fauxAssistantMessage(
			reply.map((c) => fauxToolCall(c.name, {})),
		);
		seen.push(asked);
		await run.save(asked);
		for (const [i, call] of reply.entries()) {
			const toolCallId = (asked.content[i] as ToolCall).id;
			const [text, isError] = await call.run({ run, seen, toolCallId }).then(
				(t) => [t, false] as const,
				(e) => [String(e), true] as const,
			);
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: call.name,
				content: [{ type: "text", text }],
				isError,
				timestamp: Date.now(),
			};
			seen.push(result);
			await run.save(result);
		}
		seen.push(...(await run.deliver()));
	}
}

/** The Run's Subagent Tools, which a Run at the deepest level lacks. */
const subagents = (run: RunHandle) => {
	if (!run.subagents) throw new Error("This Run has no Subagent Tools");
	return run.subagents;
};
const say =
	(text: string): Step =>
	() =>
		text;
const ask =
	(question: string): Step =>
	() => ({ question });
const call =
	(...calls: Call[]): Step =>
	() =>
		calls;
const tool = (run: Call["run"] = async () => ""): Call => ({
	name: "search",
	run,
});
const start = (...briefs: string[]): Call => ({
	name: "subagent",
	run: async ({ run, toolCallId }) =>
		`Started subagent ${(
			await subagents(run).start(
				toolCallId,
				briefs.map((brief) => ({ brief })),
			)
		).join(", ")}`,
});
const message = (number: number, text: string): Call => ({
	name: "subagent_message",
	run: async ({ run }) =>
		(await subagents(run).message(number, text)).continued
			? `Subagent ${number} continues.`
			: "Sent.",
});
const stopSubagents = (numbers: number[]): Call => ({
	name: "subagent_stop",
	run: async ({ run }) => `Stopping ${await subagents(run).stop(numbers)}`,
});
/** Resolves once `signal` aborts, at once if it already has: a Stop can land before the step listens. */
const untilAborted = (signal: AbortSignal) =>
	new Promise<void>((resolve) =>
		signal.aborted
			? resolve()
			: signal.addEventListener("abort", () => resolve(), { once: true }),
	);
// a reply that never comes; it ends only when the Run is stopped
const hang: Step = async ({ run }) => {
	await untilAborted(run.signal);
	throw new Error("aborted");
};
const fail: Step = () => {
	throw new Error("boom");
};

function gate() {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	return { gate, release };
}

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 100; i++) {
		const v = await read();
		if (ok(v)) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

const get = (id: string) => conversations.get(userId, id);
const idle = (n: number) => (v: Awaited<ReturnType<typeof get>>) =>
	v?.status === "idle" && v.messages.length === n;
const send = (text: string, conversationId?: string) =>
	conversations.send(userId, { agentId: "faux", text, conversationId });

describe.skipIf(!url)(
	"Conversation lifecycle (Postgres, scripted Runs)",
	() => {
		let stopWorker: () => Promise<void>;
		const serve = (options = {}) =>
			conversations.serveRuns(scripted, { concurrency: 1, ...options });

		beforeAll(async () => {
			// the script is one shared queue, so Runs go one at a time; "works on several Runs at once" lifts that
			stopWorker = await serve();
		});
		afterAll(() => stopWorker?.());

		beforeEach(async () => {
			override = undefined;
			script({ parent: [] });
			// Subagents may outlive a test: stop them so they neither linger nor hold up stopping the worker
			await db.execute(
				sql`select pg_notify(${runs.STOP_CHANNEL}, id::text) from conversation where status = 'running'`,
			);
			await db.execute(sql`truncate conversation, memory_setting cascade`);
		});

		it("streams a Run's events to whoever subscribes", async () => {
			const { gate: listening, release } = gate();
			script({
				parent: [
					async ({ run }) => {
						await listening;
						await run.stream({ type: "start" });
						await run.stream({
							type: "delta",
							kind: "text",
							index: 0,
							delta: "Hello",
						});
						return "Hello";
					},
				],
			});
			const id = await send("hi");
			const stream = await conversations.subscribe(
				userId,
				id,
				new AbortController().signal,
			);
			release();
			const events = await collect(
				stream as ReadableStream,
				(es) => es.at(-1)?.type === "saved",
			);
			expect(events.map((e) => e.type)).toEqual([
				"start",
				"delta",
				"end",
				"saved",
			]);
			expect(events.some((e) => "subagent" in e && e.subagent)).toBe(false);
			const view = await waitFor(() => get(id), idle(2));
			expect(view?.readOnly).toBe(false);
			expect(view?.messages[1].model).toBe("faux/faux-1");
		});

		it("stops a run that is still queued", async () => {
			const { gate: busy, release } = gate();
			let replying = false;
			let ranQueued = false;
			script({
				parent: [
					async () => {
						replying = true;
						await busy;
						return "first";
					},
					() => {
						ranQueued = true;
						return "should not run";
					},
				],
			});
			// the suite's worker runs one job at a time, so the second Conversation waits
			const first = await send("a");
			await waitFor(async () => replying, Boolean);
			const queued = await send("b");
			await conversations.stop(userId, queued);
			release();

			await waitFor(() => get(first), idle(2));
			const view = await get(queued);
			expect(view?.status).toBe("idle");
			expect(view?.messages.map((m) => m.message.role)).toEqual(["user"]);
			expect(ranQueued).toBe(false);
		});

		it("stops a Run the worker took but has not begun", async () => {
			script({ parent: [hang] });
			const findFirst = db.query.conversation.findFirst.bind(
				db.query.conversation,
			);
			let id = "";
			let stopping: Promise<unknown> | undefined;
			// the worker's first read of the Conversation: the job is taken, the Run not yet listening for a Stop
			const spy = vi
				.spyOn(db.query.conversation, "findFirst")
				.mockImplementation(((...args: Parameters<typeof findFirst>) => {
					if (id && !stopping) {
						// stop reads the Conversation too, so `stopping` is set first
						let stopped!: () => void;
						stopping = new Promise<void>((r) => {
							stopped = r;
						});
						void conversations.stop(userId, id).then(stopped);
						return stopping.then(() => findFirst(...args));
					}
					return findFirst(...args);
				}) as typeof findFirst);
			try {
				id = await send("hi");
				// no reads of ours until the worker's
				await waitFor(async () => stopping, Boolean);
				await waitFor(() => get(id), idle(1));
			} finally {
				spy.mockRestore();
			}
		});

		it("stops a Run before it saved anything, such as while it compacts", async () => {
			let compacting = false;
			script({
				parent: [
					(ctx) => {
						compacting = true;
						return hang(ctx);
					},
				],
			});
			const id = await send("next?");
			await waitFor(async () => compacting, Boolean);
			await conversations.stop(userId, id);

			const view = await waitFor(
				() => get(id),
				(v) => v?.status !== "running",
			);
			expect(view?.status).toBe("idle");
			expect(view?.messages).toHaveLength(1);
			expect(view?.compactedBefore).toEqual([]);
		});

		it("marks a failed reply as failed without saving it", async () => {
			script({ parent: [fail] });
			const id = await send("hi");
			const view = await waitFor(
				() => get(id),
				(v) => v?.status === "failed",
			);
			expect(view?.messages.map((m) => m.message.role)).toEqual(["user"]);
		});

		it("saves a compaction, which shows where the model's history starts", async () => {
			script({
				parent: [
					async ({ run }) => {
						await run.compacted("SUMMARY", run.transcript.messages[0].id, 10);
						return "ok";
					},
				],
			});
			const id = await send("hi");
			const view = await waitFor(() => get(id), idle(2));
			expect(view?.compactedBefore).toEqual([view?.messages[0].id]);
		});

		it("wakes the parent with a Notification when a Subagent finishes after the parent's reply", async () => {
			let seen: Message[] = [];
			let instructions = "";
			const { gate: done, release } = gate();
			script({
				parent: [
					call(start("find pi")),
					say("I asked a subagent and will report back"),
					say("pi is at pi.dev"),
				],
				sub: [
					async ({ run, seen: context }) => {
						seen = [...context];
						instructions = run.turn.agent.instructions;
						await done;
						return "found: pi.dev";
					},
				],
			});
			const id = await send("research pi");
			// the parent's reply is done while its Subagent still works
			const replied = await waitFor(() => get(id), idle(4));
			expect(replied?.subagents[0].outcome).toBe("running");
			// the sidebar marks a Conversation whose Subagents still work in the background
			expect(await conversations.list(userId)).toMatchObject([
				{ id, background: true },
			]);
			release();
			const view = await waitFor(() => get(id), idle(6));
			expect(view?.messages.map((m) => m.message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
				"user",
				"assistant",
			]);
			const started = view?.messages[2].message as ToolResultMessage;
			expect(JSON.stringify(started.content)).toContain("Started subagent 1");
			expect(view?.messages[4].message.content).toContain(
				'<task-notification subagent="1" status="completed">\nfound: pi.dev',
			);
			// the Subagent saw only the brief, not the Conversation, as the general worker
			expect(seen).toMatchObject([{ role: "user", content: "find pi" }]);
			expect(instructions).toBe(GENERAL_WORKER);
			expect(view?.subagents).toMatchObject([
				{
					toolCallId: started.toolCallId,
					number: 1,
					template: null,
					brief: "find pi",
					outcome: "completed",
				},
			]);
			// the parent carries its Subagents' metadata only; a panel loads a transcript when opened
			expect(view?.subagents[0]).not.toHaveProperty("messages");
			const sub = view?.subagents[0].id as string;
			expect(
				(await conversations.subagentTranscript(userId, sub))?.map(
					(m) => m.role,
				),
			).toEqual(["user", "assistant"]);
			expect(await conversations.subagentTranscript("u2", sub)).toBeUndefined();
			// the Notification knows which Subagent it came from, so it can open that panel
			expect(view?.messages[4].subagentId).toBe(sub);
			// the parent is idle with no Subagent left in the background
			expect(await conversations.list(userId)).toMatchObject([
				{ id, background: false },
			]);
			// a Subagent's Conversation is reached through its parent only
			expect(await conversations.list(userId)).toMatchObject([{ id }]);
		});

		it("streams a Subagent's reply over SSE under its row id", async () => {
			const { gate: listening, release } = gate();
			script({
				parent: [call(start("find pi")), say("Started"), say("Done")],
				sub: [
					async ({ run }) => {
						await listening;
						await run.stream({ type: "start" });
						await run.stream({
							type: "delta",
							kind: "text",
							index: 0,
							delta: "pi is at pi.dev",
						});
						return "pi is at pi.dev";
					},
				],
			});
			const id = await send("research pi");
			const stream = await conversations.subscribe(
				userId,
				id,
				new AbortController().signal,
			);
			release();
			const events = await collect(stream as ReadableStream, (es) =>
				es.some((e) => e.type === "end" && e.subagent),
			);
			const view = await waitFor(() => get(id), idle(6));
			const sub = view?.subagents[0].id;
			const mine = events.filter((e) => "subagent" in e && e.subagent === sub);
			expect(mine.map((e) => e.type)).toEqual(["start", "delta", "end"]);
		});

		it("runs a template's Subagent as its Agent, on the template's own Model", async () => {
			let turn: RunHandle["turn"] | undefined;
			script({
				parent: [
					call({
						name: "subagent",
						run: async ({ run, toolCallId }) =>
							String(
								await subagents(run).start(toolCallId, [
									{ brief: "b", template: "small" },
								]),
							),
					}),
					say("Asked"),
					say("Done"),
				],
				sub: [
					({ run }) => {
						turn = run.turn;
						return "done";
					},
				],
			});
			const id = await send("go");
			const view = await waitFor(() => get(id), idle(6));
			expect(view?.subagents[0].template).toBe("small");
			expect(turn?.agent.id).toBe("small");
			expect(turn?.model.id).toBe("faux-small");
		});

		it("refuses a template that does not exist", async () => {
			script({
				parent: [
					call({
						name: "subagent",
						run: async ({ run, toolCallId }) =>
							String(
								await subagents(run).start(toolCallId, [
									{ brief: "b", template: "nope" },
								]),
							),
					}),
					say("Oh"),
				],
			});
			const id = await send("go");
			const view = await waitFor(() => get(id), idle(4));
			const result = view?.messages[2].message as ToolResultMessage;
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.content)).toContain("NoSuchTemplate");
			expect(view?.subagents).toEqual([]);
		});

		it("passes a message to a running Subagent after its current step", async () => {
			const { gate: stepping, release } = gate();
			let second: Message[] = [];
			script({
				parent: [
					call(start("look")),
					call(message(1, "also check the docs")),
					() => {
						release();
						return "Looking";
					},
					say("Done"),
				],
				sub: [
					async () => {
						await stepping;
						return [tool()];
					},
					({ seen }) => {
						second = [...seen];
						return "checked";
					},
				],
			});
			const id = await send("look");
			const view = await waitFor(
				() => get(id),
				(v) =>
					v?.status === "idle" &&
					v.messages.at(-1)?.message.role === "assistant" &&
					v.subagents[0]?.outcome === "completed" &&
					v.messages.length === 8,
			);
			expect(JSON.stringify(second)).toContain("also check the docs");
			expect(JSON.stringify(view?.messages[6].message.content)).toContain(
				"checked",
			);
		});

		it("stops a Subagent on request, and all of them, without waking the parent, when the User stops", async () => {
			script({
				parent: [
					call(start("one", "two")),
					call(stopSubagents([1])),
					say("Two keeps going"),
				],
				sub: [hang, hang],
			});
			const id = await send("go");
			// the parent's reply is done, and the Subagent it did not stop works on
			const replied = await waitFor(
				() => get(id),
				(v) =>
					v?.status === "idle" &&
					v.messages.at(-1)?.message.role === "assistant" &&
					v.subagents[0]?.outcome === "stopped",
			);
			expect(replied?.subagents[1].outcome).toBe("running");

			await conversations.stop(userId, id);
			const view = await waitFor(
				() => get(id),
				(v) => v?.subagents[1]?.outcome === "stopped",
			);
			// a stopped Subagent's Notification waits for the User's next message instead of waking the parent
			await new Promise((r) => setTimeout(r, 300));
			const after = await get(id);
			expect(after?.status).toBe("idle");
			expect(
				after?.messages.filter((m) => m.message.role === "assistant"),
			).toHaveLength(
				view?.messages.filter((m) => m.message.role === "assistant").length ??
					0,
			);
			expect(
				after?.messages.filter((m) =>
					JSON.stringify(m.message.content).includes('status=\\"stopped\\"'),
				),
			).toHaveLength(2);
		});

		it("stops one Subagent from its panel, leaving the others and the parent as they are", async () => {
			script({
				parent: [call(start("one", "two")), say("Both started")],
				sub: [hang, hang],
			});
			const id = await send("go");
			const replied = await waitFor(
				() => get(id),
				(v) =>
					!!v &&
					idle(4)(v) &&
					v.subagents.every((s) => s.outcome === "running"),
			);
			const [one, two] = replied?.subagents ?? [];
			// nobody else can stop it
			await conversations.stopSubagent("u2", one.id);
			await conversations.stopSubagent(userId, one.id);
			const view = await waitFor(
				() => get(id),
				(v) => v?.subagents[0]?.outcome === "stopped",
			);
			expect(view?.subagents[1]).toMatchObject({
				id: two.id,
				outcome: "running",
			});
			expect(view?.status).toBe("idle");
			await conversations.stop(userId, id);
		});

		it("delivers a Notification that arrives while the parent runs between its steps, without another Run", async () => {
			let seen = "";
			script({
				parent: [
					call(start("find pi")),
					// keeps the parent's Run going until its Subagent has finished
					async () => {
						await waitFor(
							() => db.select().from(schema.subagent),
							(rows) => rows[0]?.outcome === "completed",
						);
						return [tool()];
					},
					({ seen: context }) => {
						seen = JSON.stringify(context.at(-1));
						return "pi is at pi.dev";
					},
				],
				sub: [say("found: pi.dev")],
			});
			const id = await send("research pi");
			const view = await waitFor(() => get(id), idle(7));
			expect(view?.messages.map((m) => m.message.role)).toEqual([
				"user",
				"assistant",
				"toolResult",
				"assistant",
				"toolResult",
				"user",
				"assistant",
			]);
			expect(seen).toContain("task-notification");
		});

		it("continues a finished Subagent that is messaged, which then notifies the parent again", async () => {
			let second = "";
			script({
				parent: [
					call(start("find pi")),
					say("Asked"),
					call(message(1, "now find tau")),
					say("Asked again"),
					say("pi and tau found"),
				],
				sub: [
					say("found: pi.dev"),
					({ seen }) => {
						second = JSON.stringify(seen);
						return "found: tau.dev";
					},
				],
			});
			const id = await send("research");
			const view = await waitFor(() => get(id), idle(10));
			// it continues with what it did before
			expect(second).toContain("find pi");
			expect(second).toContain("found: pi.dev");
			expect(second).toContain("now find tau");
			expect(JSON.stringify(view?.messages[8].message.content)).toContain(
				"found: tau.dev",
			);
			expect(view?.subagents[0].outcome).toBe("completed");
		});

		it("wakes the parent when a Subagent fails", async () => {
			script({
				parent: [
					call(start("find pi")),
					say("Asked"),
					say("It failed, I will look myself"),
				],
				sub: [fail],
			});
			const id = await send("research");
			const view = await waitFor(() => get(id), idle(6));
			const notified = JSON.stringify(view?.messages[4].message.content);
			expect(notified).toContain('status=\\"failed\\"');
			expect(notified).toContain("boom");
			expect(view?.subagents[0].outcome).toBe("failed");
		});

		it(`runs at most ${MAX_SUBAGENTS} Subagents of a parent at once, the rest when one finishes`, async () => {
			const { gate: done, release } = gate();
			const gated: Step = async () => {
				await done;
				return "done";
			};
			const tasks = Array.from(
				{ length: MAX_SUBAGENTS + 1 },
				(_, i) => `task ${i + 1}`,
			);
			script({
				parent: [
					call(start(...tasks)),
					say("Asked"),
					...tasks.map(() => say("ok")),
				],
				sub: tasks.map(() => gated),
			});
			const id = await send("go");
			const busy = await waitFor(
				() => get(id),
				(v) => v?.status === "idle" && v.subagents.length === MAX_SUBAGENTS + 1,
			);
			expect(busy?.subagents.map((s) => s.outcome)).toEqual([
				...Array(MAX_SUBAGENTS).fill("running"),
				"queued",
			]);
			release();
			const view = await waitFor(
				() => get(id),
				(v) =>
					v?.status === "idle" &&
					v.subagents.every((s) => s.outcome === "completed") &&
					v.messages.filter((m) =>
						JSON.stringify(m.message.content).includes("task-notification"),
					).length ===
						MAX_SUBAGENTS + 1 &&
					v.messages.at(-1)?.message.role === "assistant",
			);
			expect(view?.messages.every((m) => !m.queued)).toBe(true);
		});

		it(`refuses to start more than ${MAX_SUBAGENTS_PER_USER_MESSAGE} Subagents since the User's last message`, async () => {
			const eight = Array.from({ length: 8 }, (_, i) => `t${i}`);
			script({
				parent: [
					call(start(...eight)),
					call(start(...eight)),
					call(start("one more")),
					...Array.from({ length: 40 }, () => say("ok")),
				],
				sub: Array.from({ length: 16 }, () => say("done")),
			});
			const id = await send("go");
			const view = await waitFor(
				() => get(id),
				(v) =>
					v?.status === "idle" &&
					v.subagents.length === 16 &&
					v.subagents.every((s) => s.outcome === "completed"),
			);
			// Notifications may land between the calls
			const results = view?.messages
				.map((m) => m.message)
				.filter((m): m is ToolResultMessage => m.role === "toolResult");
			expect(results?.map((r) => r.isError)).toEqual([false, false, true]);
			expect(JSON.stringify(results?.[2].content)).toContain("BudgetExceeded");
		});

		it("reports how much of the budget was used when it refuses", async () => {
			let refused: unknown;
			script({
				parent: [
					call({
						name: "subagent",
						run: async ({ run, toolCallId }) => {
							const tasks = Array.from({ length: 17 }, () => ({ brief: "b" }));
							refused = await subagents(run)
								.start(toolCallId, tasks)
								.catch((e) => e);
							return "";
						},
					}),
					say("ok"),
				],
			});
			const id = await send("go");
			await waitFor(() => get(id), idle(4));
			expect(refused).toBeInstanceOf(BudgetExceeded);
			expect(refused).toMatchObject({ used: 0, max: 16 });
		});

		it("counts Subagents started and finished ones continued against the budget, not messages to running ones", async () => {
			const { gate: done, release } = gate();
			script({
				parent: [
					call(start("one")),
					// steering a running Subagent is not continuing it
					call(
						...Array.from({ length: MAX_SUBAGENTS_PER_USER_MESSAGE }, (_, i) =>
							message(1, `m${i}`),
						),
					),
					call(start("two")),
					() => {
						release();
						return "Waiting";
					},
					...Array.from({ length: 4 }, () => say("ok")),
				],
				sub: [
					async () => {
						await done;
						return "done";
					},
					...Array.from({ length: 3 }, () => say("done")),
				],
			});
			const id = await send("go");
			const view = await waitFor(
				() => get(id),
				(v) =>
					v?.status === "idle" &&
					v.subagents.length === 2 &&
					v.subagents.every((s) => s.outcome === "completed") &&
					v.messages.at(-1)?.message.role === "assistant",
			);
			const results = view?.messages
				.map((m) => m.message)
				.filter((m): m is ToolResultMessage => m.role === "toolResult");
			expect(results?.every((r) => !r.isError)).toBe(true);
		});

		it("queues a finished Subagent that is messaged while no slot is free, so the User's stop reaches it", async () => {
			script({
				parent: [
					call(start("first")),
					async () => {
						await waitFor(
							() => db.select().from(schema.subagent),
							(rows) => rows[0]?.outcome === "completed",
						);
						return [
							start(
								...Array.from({ length: MAX_SUBAGENTS }, (_, i) => `busy ${i}`),
							),
						];
					},
					call(message(1, "more")),
					say("Waiting"),
				],
				sub: [
					say("done"),
					...Array.from({ length: MAX_SUBAGENTS }, () => hang),
				],
			});
			const id = await send("go");
			const replied = await waitFor(
				() => get(id),
				(v) =>
					v?.status === "idle" &&
					v.messages.at(-1)?.message.role === "assistant" &&
					v.subagents.length === MAX_SUBAGENTS + 1,
			);
			expect(replied?.subagents[0].outcome).toBe("queued");
			await conversations.stop(userId, id);
			const view = await waitFor(
				() => get(id),
				(v) => !!v?.subagents.every((s) => s.outcome === "stopped"),
			);
			// it never starts again by itself
			await new Promise((r) => setTimeout(r, 300));
			const after = await get(id);
			expect(after?.subagents.map((s) => s.outcome)).toEqual(
				view?.subagents.map((s) => s.outcome),
			);
		});

		it("fails a Subagent whose Run cannot be queued, with exactly one Notification", async () => {
			const queue = runs.runQueue(runs.SUBAGENT_RUNS_QUEUE);
			const add = queue.add.bind(queue);
			let calls = 0;
			let broken: unknown;
			// the last Subagent waits for a slot; queueing it, once one is free, keeps failing
			const spy = vi.spyOn(queue, "add").mockImplementation((...args) => {
				if (++calls === MAX_SUBAGENTS + 1) broken = args[1].conversationId;
				return args[1].conversationId === broken
					? Promise.reject(new Error("queue down"))
					: add(...args);
			});
			try {
				const tasks = Array.from(
					{ length: MAX_SUBAGENTS + 1 },
					(_, i) => `task ${i + 1}`,
				);
				script({
					parent: [
						call(start(...tasks)),
						...Array.from({ length: MAX_SUBAGENTS + 3 }, () => say("ok")),
					],
					sub: Array.from({ length: MAX_SUBAGENTS }, () => say("done")),
				});
				const id = await send("go");
				const view = await waitFor(
					() => get(id),
					(v) =>
						v?.status === "idle" &&
						v.subagents.at(-1)?.outcome === "failed" &&
						v.messages.at(-1)?.message.role === "assistant",
				);
				await new Promise((r) => setTimeout(r, 300));
				const after = await get(id);
				expect(after?.subagents.map((s) => s.outcome)).toEqual([
					...Array(MAX_SUBAGENTS).fill("completed"),
					"failed",
				]);
				// one Notification per Subagent
				expect(
					view?.subagents.map(
						(s) => after?.messages.filter((m) => m.subagentId === s.id).length,
					),
				).toEqual(Array(MAX_SUBAGENTS + 1).fill(1));
			} finally {
				spy.mockRestore();
			}
		});

		it("wakes the parent in one Run for two Subagents that finish together, and delivers both Notifications", async () => {
			const { gate: done, release } = gate();
			const { gate: blocked, release: unblock } = gate();
			let blocking = false;
			let woke: Message[] = [];
			const gated: Step = async () => {
				await done;
				return "done";
			};
			script({
				parent: [
					call(start("one", "two")),
					say("Asked"),
					// another Conversation's reply holds the suite's only top-level slot
					async () => {
						blocking = true;
						await blocked;
						return "blocked";
					},
					({ seen }) => {
						woke = [...seen];
						return "Both done";
					},
				],
				sub: [gated, gated],
			});
			const id = await send("go");
			await waitFor(() => get(id), idle(4));
			const other = await send("hold on");
			await waitFor(async () => blocking, Boolean);
			release();
			await waitFor(
				() => db.select().from(schema.inbox),
				(rows) => rows.filter((r) => r.conversationId === id).length === 2,
			);
			unblock();
			await waitFor(() => get(other), idle(2));
			const view = await waitFor(() => get(id), idle(7));
			expect(view?.messages.slice(4).map((m) => m.message.role)).toEqual([
				"user",
				"user",
				"assistant",
			]);
			expect(
				woke.filter(
					(m) =>
						m.role === "user" &&
						JSON.stringify(m).includes("task-notification"),
				),
			).toHaveLength(2);
		});

		describe("nested Subagents", () => {
			it("nests a Subagent under a Subagent down to the deepest level, which starts none, and the middle one notifies only after a summary Run", async () => {
				const { gate: dug, release } = gate();
				let deepest: RunHandle["subagents"] | null = null;
				let summarized = "";
				script({
					parent: [call(start("lead")), say("Asked the lead"), say("All done")],
					sub: [
						call(start("dig")),
						say("Waiting on my helper"),
						({ seen }) => {
							summarized = JSON.stringify(seen.at(-1));
							return "summary: dug";
						},
					],
					deep: [
						async ({ run }) => {
							deepest = run.subagents;
							await dug;
							return "dug";
						},
					],
				});
				const id = await send("go");
				// the lead's Run is over, but its helper still works: no Notification yet, and the lead waits idle
				const waiting = await waitFor(
					() => get(id),
					(v) =>
						v?.status === "idle" &&
						v.subagents.length === 2 &&
						v.subagents[1].outcome === "running" &&
						v.messages.at(-1)?.message.role === "assistant",
				);
				const [lead, helper] = waiting?.subagents ?? [];
				expect(lead).toMatchObject({
					parentId: id,
					depth: 1,
					outcome: "running",
				});
				expect(helper).toMatchObject({
					parentId: lead.id,
					depth: 2,
					number: 1,
				});
				await waitFor(
					() =>
						db.query.conversation.findFirst({
							where: (c, { eq }) => eq(c.id, lead.id),
						}),
					(c) => c?.status === "idle",
				);
				expect(waiting?.messages.some((m) => m.subagentId === lead.id)).toBe(
					false,
				);
				expect(deepest).toBeUndefined();

				release();
				const view = await waitFor(() => get(id), idle(6));
				expect(view?.subagents.map((s) => s.outcome)).toEqual([
					"completed",
					"completed",
				]);
				// one Notification from the lead, with its summary
				const notified = view?.messages.filter((m) => m.subagentId);
				expect(notified?.map((m) => m.subagentId)).toEqual([lead.id]);
				expect(JSON.stringify(notified?.[0].message.content)).toContain(
					"summary: dug",
				);
				expect(summarized).toContain("task-notification");
				expect(
					(await conversations.subagentTranscript(userId, lead.id))?.map(
						(m) => m.role,
					),
				).toEqual([
					"user",
					"assistant",
					"toolResult",
					"assistant",
					"user",
					"assistant",
				]);
			});

			it("gives Subagents no Subagent Tools when the depth limit is 1, as before nesting", async () => {
				config.limits = { ...DEFAULT_LIMITS, maxSubagentDepth: 1 };
				try {
					let had: RunHandle["subagents"] | null = null;
					script({
						parent: [call(start("lead")), say("Asked"), say("Done")],
						deep: [
							({ run }) => {
								had = run.subagents;
								return "done";
							},
						],
					});
					const id = await send("go");
					await waitFor(() => get(id), idle(6));
					expect(had).toBeUndefined();
				} finally {
					config.limits = { ...DEFAULT_LIMITS };
				}
			});

			it(`shares the budget of ${MAX_SUBAGENTS_PER_USER_MESSAGE} starts across the tree, renewed only by a User message to the root`, async () => {
				const { gate: leadWaits, release } = gate();
				const refusals: unknown[] = [];
				const tryStart = (n: number): Call => ({
					name: "subagent",
					run: async ({ run, toolCallId }) => {
						await run.subagents
							?.start(
								toolCallId,
								Array.from({ length: n }, () => ({ brief: "b" })),
							)
							.catch((e) => refusals.push(e));
						return "";
					},
				});
				script({
					parent: [
						call(start("lead")),
						say("Asked"),
						say("Lead done"),
						// after the User's next message
						call(tryStart(1)),
						say("Asked again"),
						say("Done"),
					],
					sub: [
						call(tryStart(8)),
						call(tryStart(7)),
						// the root's start and these 15 spent it all
						call(tryStart(1)),
						say("Waiting"),
						say("Summed up"),
						say("One more done"),
					],
					// they end only once the lead waits, so no Notification wakes it for an extra turn
					deep: Array.from({ length: 15 }, () => async () => {
						await leadWaits;
						return "done";
					}),
				});
				const id = await send("go");
				const started = await waitFor(
					() => get(id),
					(v) => v?.subagents.length === 16,
				);
				await waitFor(
					() =>
						db.query.conversation.findFirst({
							where: (c, { eq }) =>
								eq(c.id, started?.subagents[0].id as string),
						}),
					(c) => c?.status === "idle",
				);
				release();
				const first = await waitFor(
					() => get(id),
					(v) =>
						v?.status === "idle" &&
						v.subagents.length === 16 &&
						v.subagents.every((s) => s.outcome === "completed") &&
						v.messages.at(-1)?.message.role === "assistant",
				);
				expect(refusals).toHaveLength(1);
				expect(refusals[0]).toBeInstanceOf(BudgetExceeded);
				expect(refusals[0]).toMatchObject({ used: 16 });
				// fifteen Notifications reached the lead, and one the root
				expect(first?.messages.filter((m) => m.subagentId)).toHaveLength(1);

				await send("and one more", id);
				await waitFor(
					() => get(id),
					(v) =>
						v?.status === "idle" &&
						v.subagents.length === 17 &&
						v.subagents.every((s) => s.outcome === "completed") &&
						v.messages.at(-1)?.message.role === "assistant",
				);
				expect(refusals).toHaveLength(1);
			});

			it(`runs at most ${MAX_SUBAGENTS} Subagents of a tree at once, not counting one that waits for its own`, async () => {
				const { gate: done, release } = gate();
				const gated: Step = async () => {
					await done;
					return "done";
				};
				script({
					parent: [call(start("lead")), say("Asked"), say("Done")],
					sub: [
						call(start("1", "2", "3", "4", "5")),
						say("Waiting"),
						say("Summed up"),
					],
					deep: Array.from({ length: 5 }, () => gated),
				});
				const id = await send("go");
				const busy = await waitFor(
					() => get(id),
					(v) =>
						v?.subagents.length === 6 &&
						v.subagents.filter((s) => s.outcome === "running").length === 5,
				);
				expect(busy?.subagents.map((s) => s.outcome)).toEqual([
					"running",
					...Array(MAX_SUBAGENTS).fill("running"),
					"queued",
				]);
				release();
				const view = await waitFor(() => get(id), idle(6));
				expect(view?.subagents.every((s) => s.outcome === "completed")).toBe(
					true,
				);
			});

			it("stops the whole subtree when the User stops, with Notifications that wake nobody", async () => {
				script({
					parent: [call(start("lead")), say("Asked")],
					sub: [call(start("dig")), hang],
					deep: [hang],
				});
				const id = await send("go");
				await waitFor(
					() => get(id),
					(v) =>
						v?.subagents.length === 2 &&
						v.subagents.every((s) => s.outcome === "running") &&
						v.status === "idle",
				);
				await conversations.stop(userId, id);
				const view = await waitFor(
					() => get(id),
					(v) => !!v?.subagents.every((s) => s.outcome === "stopped"),
				);
				await new Promise((r) => setTimeout(r, 300));
				const notifications = await db
					.select()
					.from(schema.inbox)
					.where(sql`${schema.inbox.subagentId} is not null`);
				expect(notifications).toHaveLength(2);
				expect(notifications.every((n) => !n.wake)).toBe(true);
				// the root did not reply again
				const replies = (v: typeof view) =>
					v?.messages.filter((m) => m.message.role === "assistant").length;
				expect(replies(await get(id))).toBe(replies(view));
				expect((await get(id))?.status).toBe("idle");
			});

			it("has a Subagent that waits for its own sum up once the User stops the last of them from its panel", async () => {
				script({
					parent: [call(start("lead")), say("Asked"), say("Done")],
					sub: [call(start("dig")), say("Waiting"), say("Dig was stopped")],
					deep: [hang],
				});
				const id = await send("go");
				const waiting = await waitFor(
					() => get(id),
					(v) =>
						v?.subagents.length === 2 &&
						v.subagents.every((s) => s.outcome === "running") &&
						v.status === "idle" &&
						v.messages.at(-1)?.message.role === "assistant",
				);
				// the lead's Run has ended, and it waits
				await waitFor(
					() =>
						db.query.conversation.findFirst({
							where: (c, { eq }) =>
								eq(c.id, waiting?.subagents[0].id as string),
						}),
					(c) => c?.status === "idle",
				);
				await conversations.stopSubagent(
					userId,
					waiting?.subagents[1].id as string,
				);
				const view = await waitFor(() => get(id), idle(6));
				expect(view?.subagents.map((s) => s.outcome)).toEqual([
					"completed",
					"stopped",
				]);
				expect(JSON.stringify(view?.messages[4].message.content)).toContain(
					"Dig was stopped",
				);
			});

			it("passes on the last answer of a Subagent stopped while it waits for its own", async () => {
				script({
					parent: [call(start("lead")), say("Asked")],
					sub: [call(start("dig")), say("Found half")],
					deep: [hang],
				});
				const id = await send("go");
				const waiting = await waitFor(
					() => get(id),
					(v) =>
						v?.subagents.length === 2 &&
						v.subagents.every((s) => s.outcome === "running") &&
						v.status === "idle",
				);
				const lead = waiting?.subagents[0].id as string;
				await waitFor(
					() =>
						db.query.conversation.findFirst({
							where: (c, { eq }) => eq(c.id, lead),
						}),
					(c) => c?.status === "idle",
				);
				await conversations.stopSubagent(userId, lead);
				const [row] = await db
					.select()
					.from(schema.subagent)
					.where(sql`${schema.subagent.conversationId} = ${lead}`);
				expect(row).toMatchObject({ outcome: "stopped", result: "Found half" });
			});

			it("has a waiting Subagent sum up only once a stopped one of its own has ended too", async () => {
				const { gate: slowStop, release: stopEnds } = gate();
				const { gate: other, release: otherEnds } = gate();
				let summedUp = false;
				// each deep Run goes by its brief, whichever starts first
				const deep: Step = async ({ run, seen }) => {
					if (JSON.stringify(seen[0]).includes("slow")) {
						await untilAborted(run.signal);
						await slowStop;
						throw new Error("aborted");
					}
					await other;
					return "other done";
				};
				script({
					parent: [call(start("lead")), say("Asked"), say("Done")],
					sub: [
						call(start("slow", "other")),
						say("Waiting"),
						() => {
							summedUp = true;
							return "Summed up";
						},
					],
					deep: [deep, deep],
				});
				const id = await send("go");
				const waiting = await waitFor(
					() => get(id),
					(v) =>
						v?.subagents.length === 3 &&
						v.subagents.every((s) => s.outcome === "running") &&
						v.status === "idle",
				);
				const lead = waiting?.subagents[0].id as string;
				await waitFor(
					() =>
						db.query.conversation.findFirst({
							where: (c, { eq }) => eq(c.id, lead),
						}),
					(c) => c?.status === "idle",
				);
				const slow = waiting?.subagents.find(
					(s) => s.parentId === lead && s.number === 1,
				);
				try {
					await conversations.stopSubagent(userId, slow?.id as string);
					otherEnds();
					await waitFor(
						() => get(id),
						(v) => v?.subagents.some((s) => s.outcome === "completed") ?? false,
					);
					await new Promise((r) => setTimeout(r, 300));
					// the stopped one still runs, so the lead keeps waiting
					expect(summedUp).toBe(false);
				} finally {
					stopEnds();
				}
				await waitFor(() => get(id), idle(6));
				expect(summedUp).toBe(true);
			});

			it("streams a nested Subagent's reply to the root's page under its id", async () => {
				const { gate: listening, release } = gate();
				script({
					parent: [call(start("lead")), say("Asked"), say("Done")],
					sub: [call(start("dig")), say("Waiting"), say("Summed up")],
					deep: [
						async ({ run }) => {
							await listening;
							await run.stream({ type: "start" });
							return "dug";
						},
					],
				});
				const id = await send("go");
				const stream = await conversations.subscribe(
					userId,
					id,
					new AbortController().signal,
				);
				release();
				const events = await collect(stream as ReadableStream, (es) =>
					es.some((e) => e.type === "start" && e.subagent),
				);
				const view = await waitFor(() => get(id), idle(6));
				expect(events.find((e) => e.type === "start")).toMatchObject({
					subagent: view?.subagents[1].id,
				});
			});
		});

		it("tells the parent's page when a Subagent compacts", async () => {
			const [parent] = await db
				.insert(schema.conversation)
				.values({ userId, agentId: "faux", title: "t", titleEdited: true })
				.returning();
			const [child] = await db
				.insert(schema.conversation)
				.values({ userId, agentId: "small", parentId: parent.id })
				.returning();
			await db.insert(schema.subagent).values({
				conversationId: child.id,
				toolCallId: "call",
				number: 1,
				brief: "b",
			});
			await db.insert(schema.inbox).values({
				conversationId: child.id,
				message: { role: "user", content: "next?", timestamp: Date.now() },
				model: "faux/faux-small",
				thinkingLevel: "off",
				wake: true,
			});
			script({
				parent: [say("ok")],
				sub: [
					async ({ run }) => {
						await run.compacted("summary", run.transcript.messages[0].id, 10);
						await run.stream({ type: "start" });
						return "done";
					},
				],
			});
			const stream = await conversations.subscribe(
				userId,
				parent.id,
				new AbortController().signal,
			);
			await runs.ensureRun(child.id);
			const events = await collect(stream as ReadableStream, (es) =>
				es.some((e) => e.type === "start"),
			);
			// the compaction showed before the reply began
			expect(events.map((e) => e.type)).toEqual(["saved", "start"]);
			await waitFor(() => get(parent.id), idle(2));
		});

		it("lets a Subagent recall neither its own Conversation nor its parent's", async () => {
			const kiwi = (conversationId: string) =>
				db.insert(schema.message).values({
					conversationId,
					message: { role: "user", content: "kiwi", timestamp: 0 },
					model: "faux/faux-1",
					thinkingLevel: "off",
				});
			const [past, parent] = await db
				.insert(schema.conversation)
				.values([
					{ userId, agentId: "faux" },
					{ userId, agentId: "faux" },
				])
				.returning();
			const [child] = await db
				.insert(schema.conversation)
				.values({ userId, agentId: "small", parentId: parent.id })
				.returning();
			await db.insert(schema.subagent).values({
				conversationId: child.id,
				toolCallId: "call",
				number: 1,
				brief: "b",
			});
			await kiwi(past.id);
			await kiwi(parent.id);
			await db.insert(schema.inbox).values({
				conversationId: child.id,
				message: { role: "user", content: "kiwi", timestamp: Date.now() },
				model: "faux/faux-small",
				thinkingLevel: "off",
				wake: true,
			});
			let found: string[] | undefined;
			script({
				parent: [say("ok")],
				sub: [
					async ({ run }) => {
						found = (await run.recall.search("kiwi")).map(
							(f) => f.conversationId,
						);
						return "done";
					},
				],
			});
			await runs.ensureRun(child.id);
			await waitFor(
				async () => found,
				(f) => f !== undefined,
			);
			expect(found).toEqual([past.id]);
			await waitFor(() => get(parent.id), idle(3));
		});

		it("answers a message left in the inbox when the User stops the Run", async () => {
			let sent: Promise<unknown> | undefined;
			// a "start" streamed before the test subscribes would be missed, and the Run would wait for a Stop forever
			const { gate: listening, release } = gate();
			script({
				parent: [
					async ({ run }) => {
						await listening;
						await run.stream({ type: "start" });
						await untilAborted(run.signal);
						// a stopped reply keeps what was generated
						return "half";
					},
					say("answer"),
				],
			});
			const id = await send("write a lot");
			const stream = await conversations.subscribe(
				userId,
				id,
				new AbortController().signal,
			);
			release();
			await collect(
				stream as ReadableStream,
				(es) => es.some((e) => e.type === "start"),
				(e) => {
					if (e.type === "start" && !sent)
						sent = (async () => {
							await send("also this", id);
							await conversations.stop(userId, id);
						})();
				},
			);
			await sent;
			const view = await waitFor(() => get(id), idle(4));
			expect(
				view?.messages.map((m) => [m.message.role, messageText(m.message)]),
			).toMatchObject([
				["user", "write a lot"],
				["assistant", "half"],
				["user", "also this"],
				["assistant", "answer"],
			]);
		});

		it(`holds a stopped Subagent's slot until its Run ends`, async () => {
			const [parent] = await db
				.insert(schema.conversation)
				.values({ userId, agentId: "faux", title: "t" })
				.returning();
			const children = await db
				.insert(schema.conversation)
				.values(
					Array.from({ length: MAX_SUBAGENTS + 1 }, (_, i) => ({
						userId,
						parentId: parent.id,
						// as if their Runs were underway
						status:
							i < MAX_SUBAGENTS ? ("running" as const) : ("idle" as const),
					})),
				)
				.returning();
			await db.insert(schema.subagent).values(
				children.map((c, i) => ({
					conversationId: c.id,
					toolCallId: "call",
					number: i + 1,
					brief: "b",
					outcome:
						i < MAX_SUBAGENTS ? ("running" as const) : ("queued" as const),
				})),
			);
			const waiting = children[MAX_SUBAGENTS];
			await db.insert(schema.inbox).values({
				conversationId: waiting.id,
				message: { role: "user", content: "b", timestamp: Date.now() },
				model: "faux/faux-1",
				thinkingLevel: "off",
				wake: true,
			});
			await runs.stopSubagents(parent.id, async () => {}, [1]);
			// its Run has yet to end, so the slot is still taken
			expect(await runs.ensureRun(waiting.id)).toBe(false);
		});

		it("stops and drops, on retry, the Subagents the failed reply started", async () => {
			script({
				parent: [call(start("find pi")), fail, say("retried")],
				sub: [hang],
			});
			const id = await send("research");
			await waitFor(
				() => get(id),
				(v) => v?.status === "failed" && v.subagents[0]?.outcome === "running",
			);
			const { ensureSandbox } = await import("./index.ts");
			const o = memoryOrrery();
			const [sub] = await db
				.select({ id: schema.conversation.id })
				.from(schema.conversation)
				.where(sql`${schema.conversation.parentId} = ${id}`);
			await ensureSandbox(sub.id, o.client, provider);
			await sandboxed(o).retry(userId, id);
			expect(o.state("sb1")).toBe("deleted");
			const view = await waitFor(
				() => get(id),
				(v) => v?.status === "idle",
			);
			expect(view?.messages.map((m) => m.message.role)).toEqual([
				"user",
				"assistant",
			]);
			expect(view?.subagents).toEqual([]);
		});

		it("starts one Run for two wake inputs that arrive together, and delivers both", async () => {
			script({ parent: [say("Both")] });
			const [{ id }] = await db
				.insert(schema.conversation)
				.values({ userId, agentId: "faux" })
				.returning({ id: schema.conversation.id });
			await db.insert(schema.inbox).values(
				["one", "two"].map((content) => ({
					conversationId: id,
					message: { role: "user", content, timestamp: Date.now() },
					model: "faux/faux-1",
					thinkingLevel: "off",
					wake: true,
				})),
			);
			const started = await Promise.all([
				runs.ensureRun(id),
				runs.ensureRun(id),
			]);
			expect(started.filter(Boolean)).toHaveLength(1);
			const view = await waitFor(() => get(id), idle(3));
			expect(
				view?.messages.map((m) => [m.message.role, m.message.content]),
			).toMatchObject([
				["user", "one"],
				["user", "two"],
				["assistant", [{ type: "text", text: "Both" }]],
			]);
		});

		describe("Unread", () => {
			const unread = async (id: string) =>
				(await conversations.list(userId)).find((c) => c.id === id)?.unread;

			it("marks a Conversation Unread when its Run ends with a reply, until its User has seen it", async () => {
				script({ parent: [say("done")] });
				const id = await send("hi");
				await waitFor(() => get(id), idle(2));
				expect(await unread(id)).toBe(true);
				expect((await get(id))?.unread).toBe(true);
				// nobody else can mark it seen
				expect(await conversations.seen("u2", id)).toBe(false);
				expect(await unread(id)).toBe(true);
				expect(await conversations.seen(userId, id)).toBe(true);
				expect(await unread(id)).toBe(false);
			});

			it("leaves Unread alone when the User stops the Run", async () => {
				script({ parent: [say("done"), hang, hang] });
				const id = await send("hi");
				await waitFor(() => get(id), idle(2));
				// still unread: the stopped Run leaves it so
				await send("more", id);
				await waitFor(
					() => get(id),
					(v) => v?.status === "running",
				);
				await conversations.stop(userId, id);
				await waitFor(() => get(id), idle(3));
				expect(await unread(id)).toBe(true);
				// seen: the stopped Run does not mark it unread again
				await conversations.seen(userId, id);
				await send("again", id);
				await waitFor(
					() => get(id),
					(v) => v?.status === "running",
				);
				await conversations.stop(userId, id);
				await waitFor(() => get(id), idle(4));
				expect(await unread(id)).toBe(false);
			});

			it("never marks a Subagent's Conversation Unread", async () => {
				script({
					parent: [call(start("find pi")), say("asked"), say("pi.dev")],
					sub: [say("found")],
				});
				const id = await send("research");
				await waitFor(() => get(id), idle(6));
				const [sub] = await db
					.select({ unread: schema.conversation.unread })
					.from(schema.conversation)
					.where(sql`${schema.conversation.parentId} = ${id}`);
				expect(sub.unread).toBe(false);
				expect(await unread(id)).toBe(true);
			});
		});

		describe("Question", () => {
			const listed = async (id: string) =>
				(await conversations.list(userId)).find((c) => c.id === id);

			it("ends the Run with a Question and waits for the User's reply, which clears it", async () => {
				script({ parent: [ask("Which pi?"), say("pi.dev it is")] });
				const id = await send("find pi");
				const asked = await waitFor(() => get(id), idle(3));
				expect(asked?.awaitingReply).toBe(true);
				expect(await listed(id)).toMatchObject({
					awaitingReply: true,
					unread: true,
				});
				await send("the agent", id);
				// any message from the User answers it
				expect((await listed(id))?.awaitingReply).toBe(false);
				const view = await waitFor(() => get(id), idle(5));
				expect(view?.awaitingReply).toBe(false);
				expect(view?.messages.map((m) => m.message.role)).toEqual([
					"user",
					"assistant",
					"toolResult",
					"user",
					"assistant",
				]);
			});

			it("holds a Notification that arrives while a Question waits, and delivers it with the User's reply", async () => {
				const { gate: done, release } = gate();
				let answered: Message[] = [];
				script({
					parent: [
						call(start("find pi")),
						ask("Which pi?"),
						({ seen }) => {
							answered = seen.slice(-2);
							return "both in";
						},
					],
					sub: [
						async () => {
							await done;
							return "found: pi.dev";
						},
					],
				});
				const id = await send("research pi");
				await waitFor(() => get(id), idle(5));
				release();
				await waitFor(
					() => get(id),
					(v) => v?.subagents[0]?.outcome === "completed",
				);
				// had the Notification started a Run, it would have taken the last step
				await new Promise((r) => setTimeout(r, 300));
				const waiting = await get(id);
				expect(waiting).toMatchObject({ status: "idle", awaitingReply: true });
				expect(waiting?.messages.filter((m) => m.queued)).toHaveLength(1);

				await send("the language", id);
				const view = await waitFor(() => get(id), idle(8));
				expect(answered.map((m) => messageText(m))).toEqual([
					expect.stringContaining("<task-notification"),
					"the language",
				]);
				expect(view?.awaitingReply).toBe(false);
			});

			it("withdraws the Question when the User retries the Turn that asked it", async () => {
				script({ parent: [ask("Which pi?"), say("retried")] });
				const id = await send("find pi");
				await waitFor(() => get(id), idle(3));
				expect(await conversations.retry(userId, id)).toBe(true);
				const view = await waitFor(() => get(id), idle(2));
				expect(view?.awaitingReply).toBe(false);
				expect(
					view?.messages.map((m) => [m.message.role, messageText(m.message)]),
				).toEqual([
					["user", "find pi"],
					["assistant", "retried"],
				]);
			});
		});

		it("titles a Conversation unless the User renamed it", async () => {
			script({
				parent: [
					async ({ run }) => {
						await run.setTitle("Mine");
						return "ok";
					},
					async ({ run }) => {
						await run.setTitle("Not mine");
						return "ok";
					},
				],
			});
			const id = await send("hi");
			await waitFor(() => get(id), idle(2));
			expect((await get(id))?.title).toBe("Mine");
			await conversations.rename(userId, id, "Renamed");
			await send("again", id);
			await waitFor(() => get(id), idle(4));
			expect((await get(id))?.title).toBe("Renamed");
		});

		it("gives a Run no Memories from when its User turns memory off, and them again once it is back on", async () => {
			const has = async ({ run }: Ctx) => String(!!run.memories);
			script({ parent: [has, has, has] });
			const id = await send("hi");
			await waitFor(() => get(id), idle(2));
			await userMemories(userId).setOn(false);
			await send("again", id);
			await waitFor(() => get(id), idle(4));
			await userMemories(userId).setOn(true);
			await send("back", id);
			await waitFor(() => get(id), idle(6));
			expect(
				(await get(id))?.messages
					.filter((m) => m.message.role === "assistant")
					.map((m) => messageText(m.message)),
			).toEqual(["true", "false", "true"]);
		});

		it("snapshots the SKILL.md body of a Skill the User invokes into the message, untouched by later versions", async () => {
			skillMds.set(
				1,
				"---\nname: pdf\ndescription: PDFs\n---\n\n# PDF\n\nUse pypdf.\n",
			);
			script({ parent: [say("ok")] });
			const id = await conversations.send(userId, {
				agentId: "skilled",
				text: "/skill:pdf merge a.pdf and b.pdf",
			});
			await waitFor(() => get(id), idle(2));
			skillMds.set(1, "---\nname: pdf\ndescription: PDFs\n---\nChanged.");
			const [question] = (await get(id))?.messages ?? [];
			expect(messageText(question.message)).toBe(
				'<skill name="pdf" location="/workspace/.skills/pdf/SKILL.md">\nReferences are relative to /workspace/.skills/pdf.\n\n# PDF\n\nUse pypdf.\n</skill>\n\nmerge a.pdf and b.pdf',
			);
		});

		it("lets the User invoke a Skill the Agent may not invoke itself, without further text", async () => {
			skillMds.set(2, "---\nname: manual\n---\nBy hand.");
			script({ parent: [say("ok")] });
			const id = await conversations.send(userId, {
				agentId: "skilled",
				text: "/skill:manual",
			});
			await waitFor(() => get(id), idle(2));
			const [question] = (await get(id))?.messages ?? [];
			expect(messageText(question.message)).toBe(
				'<skill name="manual" location="/workspace/.skills/manual/SKILL.md">\nReferences are relative to /workspace/.skills/manual.\n\nBy hand.\n</skill>',
			);
		});

		it("refuses a Skill the Agent does not allow or that is unavailable", async () => {
			for (const [agentId, text] of [
				["skilled", "/skill:gone do it"],
				["faux", "/skill:pdf do it"],
			])
				await expect(
					conversations.send(userId, { agentId, text }),
				).rejects.toThrow("This Skill is unavailable");
			expect(await conversations.list(userId)).toEqual([]);
		});

		it("offers each Agent's available Skills for the User to invoke, those the Agent may not invoke included", async () => {
			const options = await conversations.agentOptions();
			expect(options.find((a) => a.id === "skilled")?.skills).toEqual([
				{ name: "pdf", description: "PDFs" },
				{ name: "manual", description: "By hand" },
			]);
			expect(options.find((a) => a.id === "faux")?.skills).toEqual([]);
		});

		it("keeps a Conversation Incognito from its start on, for its Runs and its Subagents', and marks it", async () => {
			const seen: boolean[] = [];
			const note: Step = ({ run }) => {
				seen.push(!run.memories);
				return "ok";
			};
			script({
				parent: [
					({ run }) => {
						seen.push(!run.memories);
						return [start("look")];
					},
					say("started"),
					note,
					note,
				],
				sub: [note],
			});
			const id = await conversations.send(userId, {
				agentId: "faux",
				text: "hi",
				incognito: true,
			});
			await waitFor(
				() => get(id),
				(v) => v?.status === "idle" && seen.length === 3,
			);
			// a later message cannot turn it off
			await conversations.send(userId, {
				conversationId: id,
				text: "again",
				incognito: false,
			});
			await waitFor(
				() => get(id),
				(v) => v?.status === "idle" && seen.length === 4,
			);
			expect(seen).toEqual([true, true, true, true]);
			expect((await get(id))?.incognito).toBe(true);
			const started = await conversations.start(userId, "faux", {
				incognito: true,
			});
			script({
				parent: [
					({ run }) => {
						seen.push(!run.memories);
						return "plain";
					},
				],
			});
			const plain = await send("hi");
			await waitFor(() => get(plain), idle(2));
			expect(seen.at(-1)).toBe(false);
			expect(
				Object.fromEntries(
					(await conversations.list(userId)).map((c) => [c.id, c.incognito]),
				),
			).toEqual({ [id]: true, [started]: true, [plain]: false });
		});

		describe("Unattended Runs", () => {
			afterAll(() => {
				config.limits = { ...DEFAULT_LIMITS };
			});
			/** As a Scheduled Task or a Timer would: an input with an origin, under the root's lock. */
			const queued = async (id: string, text: string) => {
				await db.transaction(async (tx) => {
					await runs.lockRoot(tx, id);
					await runs.queueInput(tx, {
						conversationId: id,
						message: { role: "user", content: text, timestamp: Date.now() },
						model: "faux/faux-1",
						thinkingLevel: "off",
						origin: "timer",
					});
				});
				await runs.ensureRun(id);
			};

			it("are a Conversation's Runs, its Subagents' included, from an input with an origin until the User's next message", async () => {
				const seen: boolean[] = [];
				const note =
					(then: string | Call[]): Step =>
					({ run }) => {
						seen.push(run.unattended);
						return then;
					};
				script({
					parent: [
						note("hi"),
						note([start("look")]),
						say("started"),
						note("done"),
						note("again"),
					],
					sub: [note("found")],
				});
				const id = await send("hi");
				await waitFor(() => get(id), idle(2));
				await queued(id, "check the build");
				await waitFor(
					() => get(id),
					(v) => v?.status === "idle" && seen.length === 4,
				);
				await send("thanks", id);
				await waitFor(
					() => get(id),
					(v) => v?.status === "idle" && seen.length === 5,
				);
				expect(seen).toEqual([false, true, true, true, false]);
				const origins = (await get(id))?.messages
					.filter((m) => m.message.role === "user")
					.map((m) => m.origin);
				expect(origins).toEqual([null, "timer", null, null]);
			});

			it("are aborted past the wall-clock limit, as a stop that is no User's, and end partial; attended Runs are not", async () => {
				config.limits = { ...DEFAULT_LIMITS, unattendedMaxDuration: 1 };
				let reason: unknown;
				let outcome: string | undefined;
				script({
					parent: [
						say("hi"),
						call(start("dig")),
						say("started"),
						async ({ run }) => {
							await untilAborted(run.signal);
							reason = run.signal.reason;
							return "half";
						},
						// an attended Run taking longer than the limit
						async () => {
							await new Promise((r) => setTimeout(r, 1500));
							return "slow but whole";
						},
					],
					sub: [
						async ({ run }) => {
							await untilAborted(run.signal);
							outcome =
								run.signal.reason instanceof RunTimedOut
									? "timed out"
									: "stopped";
							return "part of it";
						},
					],
				});
				const id = await send("hi");
				await waitFor(() => get(id), idle(2));
				await queued(id, "dig in the background");
				// the Subagent's Notification wakes the parent as a partial result, and that Run is timed out too
				const view = await waitFor(
					() => get(id),
					(v) => v?.status === "idle" && v.messages.length === 8,
				);
				expect(outcome).toBe("timed out");
				expect(view?.subagents.map((s) => s.outcome)).toEqual(["partial"]);
				expect(messageText(view?.messages[6].message as Message)).toContain(
					'status="partial"',
				);
				expect(reason).toBeInstanceOf(RunTimedOut);
				await send("take your time", id);
				const attended = await waitFor(() => get(id), idle(10));
				expect(messageText(attended?.messages[9].message as Message)).toBe(
					"slow but whole",
				);
			});
		});

		describe("Timer", () => {
			afterAll(() => {
				config.limits = { ...DEFAULT_LIMITS };
			});
			const setTimer = (delay: number, note: string): Call => ({
				name: "set_timer",
				run: async ({ run }) =>
					`Rings at ${(await run.timer?.set(delay, note))?.toISOString()}`,
			});
			const cancelTimer: Call = {
				name: "cancel_timer",
				run: async ({ run }) => `Cancelled: ${await run.timer?.cancel()}`,
			};
			const timerOf = async (id: string) => (await get(id))?.timer;
			/** Rings the Timer as its job does once it is due. */
			const ring = async (id: string) => {
				const set = await timerOf(id);
				await timers.ring(id, set ? set.ringsAt.getTime() : 0);
			};

			it("rings with its note, on the Model and thinking of the Turn that set it, and wakes the Conversation unattended", async () => {
				const unattended: boolean[] = [];
				let noted: Message[] = [];
				script({
					parent: [
						call(setTimer(600, "check the build")),
						say("I will check back"),
						say("ok"),
						({ run, seen }) => {
							unattended.push(run.unattended);
							noted = seen.slice(-1);
							return "the build passed";
						},
					],
				});
				const before = Date.now();
				const id = await conversations.send(userId, {
					agentId: "faux",
					text: "build it",
					thinking: "high",
				});
				await waitFor(() => get(id), idle(4));
				const set = await timerOf(id);
				expect(set?.note).toBe("check the build");
				expect(set?.ringsAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
				expect(
					await runs
						.runQueue(timers.TIMERS_QUEUE)
						.getJob(`timer:${id}:${set?.ringsAt.getTime()}`),
				).toBeTruthy();
				// a later message on other settings leaves the Timer's own
				await conversations.send(userId, {
					agentId: "faux",
					text: "thanks",
					thinking: "off",
					conversationId: id,
				});
				await waitFor(() => get(id), idle(6));
				await ring(id);
				const view = await waitFor(() => get(id), idle(8));
				expect(unattended).toEqual([true]);
				expect(messageText(noted[0])).toContain("check the build");
				const note = view?.messages[6];
				expect(note).toMatchObject({ origin: "timer", thinkingLevel: "high" });
				expect(view?.timer).toBeNull();
			});

			it("rings a minute to a day later, and a Subagent sets none", async () => {
				const results: string[] = [];
				const record = (delay: number): Call => ({
					name: "set_timer",
					run: async (ctx) => {
						const r = await setTimer(delay, "n").run(ctx).catch(String);
						results.push(r.startsWith("Rings") ? "set" : r.split(":")[0]);
						return r;
					},
				});
				let subTimer: unknown = "unset";
				script({
					parent: [
						call(record(59), record(86_401), record(60), record(86_400)),
						call(start("look")),
						say("ok"),
						say("done"),
					],
					sub: [
						({ run }) => {
							subTimer = run.timer;
							return "found";
						},
					],
				});
				const id = await send("hi");
				await waitFor(
					() => get(id),
					(v) => v?.status === "idle" && subTimer !== "unset",
				);
				expect(results).toEqual([
					"TimerDelayOutOfRange",
					"TimerDelayOutOfRange",
					"set",
					"set",
				]);
				expect(subTimer).toBeUndefined();
			});

			it("rings by its delayed job once due", async () => {
				script({ parent: [say("hi"), say("checked")] });
				const id = await send("hi");
				await waitFor(() => get(id), idle(2));
				// as set_timer does, but due at once
				await db.insert(schema.timer).values({
					conversationId: id,
					note: "look again",
					ringsAt: new Date(1000),
					messageId: sql`(select max(id) from message)`,
					model: "faux/faux-1",
					thinkingLevel: "off",
				});
				await runs
					.runQueue(timers.TIMERS_QUEUE)
					.add("ring", { conversationId: id, ringsAt: 1000 });
				const view = await waitFor(() => get(id), idle(4));
				expect(view?.messages[2].origin).toBe("timer");
			});

			it("does nothing when its job comes after it was cancelled or replaced", async () => {
				script({
					parent: [
						call(setTimer(600, "first")),
						call(setTimer(900, "second")),
						say("set"),
					],
				});
				const id = await send("hi");
				await waitFor(() => get(id), idle(6));
				const second = await timerOf(id);
				expect(second?.note).toBe("second");
				// the first one's job
				await timers.ring(id, (second?.ringsAt.getTime() ?? 0) - 300_000);
				expect(await timerOf(id)).toEqual(second);
				await conversations.cancelTimer(userId, id);
				expect(await timerOf(id)).toBeNull();
				await timers.ring(id, second?.ringsAt.getTime() ?? 0);
				const view = await get(id);
				expect(view).toMatchObject({ status: "idle" });
				expect(view?.messages).toHaveLength(6);
			});

			it("delivers its note at the next step boundary of a Run under way", async () => {
				const { gate: rung, release } = gate();
				let delivered: Message[] = [];
				script({
					parent: [
						call(setTimer(600, "check")),
						call(
							tool(async () => {
								await rung;
								return "found";
							}),
						),
						({ seen }) => {
							delivered = seen.slice(-1);
							return "done";
						},
					],
				});
				const id = await send("hi");
				await waitFor(timerOf.bind(null, id), (t) => !!t);
				await ring(id);
				release();
				await waitFor(() => get(id), idle(7));
				expect(messageText(delivered[0])).toContain("check");
			});

			it("is cancelled by the Agent, by a Stop, by a Question, by retrying the Turn that set it, and with its Conversation", async () => {
				script({
					parent: [
						call(setTimer(600, "a")),
						call(cancelTimer),
						say("cancelled"),
						// Stop
						call(setTimer(600, "b")),
						hang,
						// Question
						call(setTimer(600, "c")),
						ask("Which?"),
						// retry: the reply that set it fails
						call(setTimer(600, "d")),
						fail,
						say("retried"),
						// deletion
						call(setTimer(600, "e")),
						say("set"),
					],
				});
				const id = await send("hi");
				await waitFor(() => get(id), idle(6));
				expect(await timerOf(id)).toBeNull();

				await send("again", id);
				await waitFor(timerOf.bind(null, id), (t) => t?.note === "b");
				await conversations.stop(userId, id);
				await waitFor(
					() => get(id),
					(v) => v?.status === "idle",
				);
				expect(await timerOf(id)).toBeNull();

				await send("ask me", id);
				const asked = await waitFor(
					() => get(id),
					(v) => v?.status === "idle" && !!v.awaitingReply,
				);
				expect(asked?.timer).toBeNull();

				await send("fail", id);
				await waitFor(
					() => get(id),
					(v) => v?.status === "failed",
				);
				expect((await timerOf(id))?.note).toBe("d");
				await conversations.retry(userId, id);
				const retried = await waitFor(
					() => get(id),
					(v) =>
						v?.status === "idle" &&
						messageText(v.messages.at(-1)?.message as Message) === "retried",
				);
				expect(retried?.timer).toBeNull();

				await send("last", id);
				await waitFor(timerOf.bind(null, id), (t) => t?.note === "e");
				await waitFor(
					() => get(id),
					(v) => v?.status === "idle",
				);
				await conversations.delete(userId, id);
				expect(await db.select().from(schema.timer)).toEqual([]);
			});

			it("stays set when the User writes, which renews the rings it may make", async () => {
				config.limits = { ...DEFAULT_LIMITS, timerRingsPerUserMessage: 1 };
				script({
					parent: [
						call(setTimer(600, "once")),
						say("set"),
						call(setTimer(600, "twice")),
						say("refused"),
						call(setTimer(600, "again")),
						say("set again"),
						say("noted"),
					],
				});
				const id = await send("hi");
				await waitFor(() => get(id), idle(4));
				await ring(id);
				const refused = await waitFor(() => get(id), idle(8));
				expect(refused?.messages[6].message).toMatchObject({
					role: "toolResult",
					isError: true,
				});
				expect(messageText(refused?.messages[6].message as Message)).toContain(
					"TimerLimitReached",
				);
				expect(refused?.timer).toBeNull();

				// the User's message renews them
				await send("go on", id);
				await waitFor(() => get(id), idle(12));
				expect((await timerOf(id))?.note).toBe("again");
				// and leaves the Timer set
				await send("more", id);
				await waitFor(() => get(id), idle(14));
				expect((await timerOf(id))?.note).toBe("again");
			});
		});

		it("hides a Conversation from everyone but its owner", async () => {
			script({ parent: [say("hi")] });
			const id = await send("hi");
			expect(await conversations.get("admin", id)).toBeUndefined();
			expect(await conversations.list("admin")).toEqual([]);
			expect(
				await conversations.subscribe(
					"admin",
					id,
					new AbortController().signal,
				),
			).toBeUndefined();
			await expect(
				conversations.send("admin", { conversationId: id, text: "x" }),
			).rejects.toThrow("Conversation not found");
			await waitFor(() => get(id), idle(2));
		});

		describe("RunHandle contract, alike in Postgres and memoryRun", () => {
			const text = (ms: Message[]) => ms.map(messageText);
			/** A scenario plays one Run; `push` is an input arriving meanwhile. */
			type Scenario = (
				run: RunHandle,
				push: (text: string) => Promise<void>,
			) => Promise<unknown>;
			const reply = (run: RunHandle) => run.save(fauxAssistantMessage("ok"));
			const scenarios: [string, Scenario, unknown][] = [
				[
					"delivers the inputs that arrived, in order",
					async (run, push) => {
						await push("two");
						await push("three");
						const delivered = text(await run.deliver());
						await reply(run);
						return [
							text(run.transcript.messages.map((m) => m.message)),
							delivered,
							text(await run.finish()),
						];
					},
					[["one"], ["two", "three"], []],
				],
				[
					"ends the Run when finish has no input left",
					async (run) => {
						await reply(run);
						return text(await run.finish());
					},
					[],
				],
				[
					"goes on with the inputs that arrived before finish",
					async (run, push) => {
						await reply(run);
						await push("again");
						const next = text(await run.finish());
						await reply(run);
						return [next, text(await run.finish())];
					},
					[["again"], []],
				],
				[
					"keeps the Conversation's one Sandbox, starting it once stopped",
					async (run) => {
						const o = memoryOrrery();
						const first = await run.sandbox(o.client, provider);
						const again = await run.sandbox(o.client, provider);
						o.stop(first.id);
						const woken = await run.sandbox(o.client, provider);
						await reply(run);
						await run.finish();
						return [
							first,
							again,
							woken,
							o.calls.filter((c) => c.startsWith("createSandbox")).length,
						];
					},
					[
						{ id: "sb1", woke: true },
						{ id: "sb1", woke: false },
						{ id: "sb1", woke: true },
						1,
					],
				],
			];

			for (const [name, scenario, expected] of scenarios) {
				it(`${name} (Postgres)`, async () => {
					let result: unknown;
					override = async (run) => {
						result = await scenario(run, async (t) => {
							await send(t, run.conversationId);
						});
					};
					const id = await send("one");
					await waitFor(
						() => get(id),
						(v) => v?.status === "idle" && !v.messages.some((m) => m.queued),
					);
					expect(result).toEqual(expected);
				});

				it(`${name} (memoryRun)`, async () => {
					const memory = memoryRun({
						transcript: {
							messages: [
								{
									id: 1,
									message: { role: "user", content: "one", timestamp: 0 },
									createdAt: new Date(),
								},
							],
						},
						turn: {} as RunHandle["turn"],
					});
					const result = await scenario(memory.run, async (t) => {
						memory.push({ role: "user", content: t, timestamp: 0 });
					});
					expect(result).toEqual(expected);
					expect(memory.over).toBe(true);
				});
			}
		});

		it("creates one Sandbox for a Conversation asked for it twice at once, and keeps its id", async () => {
			const { ensureSandbox } = await import("./index.ts");
			const [conv] = await db
				.insert(schema.conversation)
				.values({ userId, agentId: "faux" })
				.returning();
			const o = memoryOrrery();
			const both = await Promise.all([
				ensureSandbox(conv.id, o.client, provider),
				ensureSandbox(conv.id, o.client, provider),
			]);
			expect(both.map((s) => s.id)).toEqual(["sb1", "sb1"]);
			expect(o.calls.filter((c) => c.startsWith("createSandbox"))).toHaveLength(
				1,
			);
			const [row] = await db
				.select({ sandboxId: schema.conversation.sandboxId })
				.from(schema.conversation)
				.where(sql`${schema.conversation.id} = ${conv.id}`);
			expect(row.sandboxId).toBe("sb1");
		});

		describe("downloading an Attachment", () => {
			const setup = async () => {
				const o = memoryOrrery();
				const { store, objects } = memoryStore();
				const files = createConversations({
					store,
					config: async () => ({ ...config, sandboxProvider: provider }),
					skillFiles: async () => [],
					orrery: () => o.client,
				});
				const [conv] = await db
					.insert(schema.conversation)
					.values({ userId, agentId: "faux" })
					.returning();
				const [sub] = await db
					.insert(schema.conversation)
					.values({ userId, agentId: null, parentId: conv.id })
					.returning();
				// an Attachment in each, named after its Conversation, as `attach` keeps one
				for (const c of [conv, sub]) {
					objects.set(c.id, new TextEncoder().encode(c.id));
					await db.insert(schema.attachment).values({
						conversationId: c.id,
						name: `${c.id}.pdf`,
						size: c.id.length,
						key: c.id,
						sent: true,
					});
				}
				return { o, files, conv, sub };
			};

			it("streams it to the Conversation's owner, a Subagent's too, from object storage without a Sandbox", async () => {
				const { o, files, conv, sub } = await setup();
				for (const c of [conv, sub]) {
					const got = await files.openFile(userId, c.id, `${c.id}.pdf`);
					if (!("file" in got)) throw new Error(got.error);
					expect(got.file.name).toBe(`${c.id}.pdf`);
					expect(got.file.size).toBe(c.id.length);
					expect(await new Response(got.file.body).text()).toBe(c.id);
				}
				expect(o.calls).toEqual([]);
			});

			it("refuses anyone but the owner, and names not attached in that Conversation", async () => {
				const { files, conv, sub } = await setup();
				for (const c of [conv, sub])
					expect(await files.openFile("u2", c.id, `${c.id}.pdf`)).toEqual({
						error: "not_found",
					});
				expect(await files.openFile(userId, conv.id, `${sub.id}.pdf`)).toEqual({
					error: "not_found",
				});
				expect(await files.openFile(userId, conv.id, "../etc/passwd")).toEqual({
					error: "not_found",
				});
			});
		});

		describe("Sandboxes go with their Conversation", () => {
			const setup = async () => {
				const { ensureSandbox } = await import("./index.ts");
				const o = memoryOrrery();
				const withSandboxes = sandboxed(o);
				const [parent] = await db
					.insert(schema.conversation)
					.values({ userId, agentId: "faux" })
					.returning();
				const [child] = await db
					.insert(schema.conversation)
					.values({ userId, agentId: "faux", parentId: parent.id })
					.returning();
				const sandboxes = [
					(await ensureSandbox(parent.id, o.client, provider)).id,
					(await ensureSandbox(child.id, o.client, provider)).id,
				];
				return { o, withSandboxes, parent, child, sandboxes };
			};
			const rows = () =>
				db.select({ id: schema.conversation.id }).from(schema.conversation);

			it("gives a Subagent's Conversation a Sandbox of its own, and deletes both with the Conversation", async () => {
				const { o, withSandboxes, parent, sandboxes } = await setup();
				expect(sandboxes).toEqual(["sb1", "sb2"]);
				await withSandboxes.delete(userId, parent.id);
				expect(await rows()).toEqual([]);
				expect(sandboxes.map(o.state)).toEqual(["deleted", "deleted"]);
			});

			it("deletes the Conversation when orrery cannot be reached, and logs the Sandboxes left behind", async () => {
				const { o, withSandboxes, parent } = await setup();
				o.down = true;
				const log = vi.spyOn(console, "error").mockImplementation(() => {});
				try {
					await withSandboxes.delete(userId, parent.id);
					expect(await rows()).toEqual([]);
					expect(log.mock.calls.map((c) => c[0])).toEqual([
						expect.stringContaining("sb1"),
						expect.stringContaining("sb2"),
					]);
				} finally {
					log.mockRestore();
				}
			});
		});

		// last: these swap the worker
		it("works on several Runs at once", async () => {
			await stopWorker();
			stopWorker = await conversations.serveRuns(scripted);
			const { gate: done, release } = gate();
			let replying = 0;
			const gated: Step = async () => {
				replying++;
				await done;
				return "done";
			};
			script({ parent: [gated, gated] });
			const ids = [await send("a"), await send("b")];
			// both replies are underway before either may finish
			await waitFor(
				async () => replying,
				(n) => n === 2,
			);
			release();
			for (const id of ids) await waitFor(() => get(id), idle(2));
			await stopWorker();
			stopWorker = await serve();
		});

		it("queues again, when the worker starts, a Run left running without a job", async () => {
			await stopWorker();
			script({ parent: [say("back")] });
			// as after a crash between saving a Run's start and queueing it
			const [{ id }] = await db
				.insert(schema.conversation)
				.values({ userId, agentId: "faux", status: "running" })
				.returning({ id: schema.conversation.id });
			await db.insert(schema.inbox).values({
				conversationId: id,
				message: { role: "user", content: "hi", timestamp: Date.now() },
				model: "faux/faux-1",
				thinkingLevel: "off",
				wake: true,
			});
			stopWorker = await serve();
			const view = await waitFor(() => get(id), idle(2));
			expect(view?.messages.map((m) => m.message.role)).toEqual([
				"user",
				"assistant",
			]);
		});

		it("queues a Run once when the worker's startup requeue races the start that saved it", async () => {
			await stopWorker();
			script({ parent: [say("back"), say("again")] });
			// a Run's start is saved, but not yet queued
			const [{ id }] = await db
				.insert(schema.conversation)
				.values({ userId, agentId: "faux", status: "running", jobId: "run-1" })
				.returning({ id: schema.conversation.id });
			await db.insert(schema.inbox).values({
				conversationId: id,
				message: { role: "user", content: "hi", timestamp: Date.now() },
				model: "faux/faux-1",
				thinkingLevel: "off",
				wake: true,
			});
			stopWorker = await serve();
			// the start queues it after the worker's requeue did
			await runs.enqueue(id);
			await waitFor(() => get(id), idle(2));
			// a second job would find nothing to reply to and fail the Conversation
			await new Promise((r) => setTimeout(r, 500));
			expect((await get(id))?.status).toBe("idle");
		});

		it("fails a run whose worker crashed, so it can be retried", async () => {
			await stopWorker();
			let picked = false;
			// a worker that takes the job and then dies without finishing it
			const crashing = new Worker(
				runs.AGENT_RUNS_QUEUE,
				() => {
					picked = true;
					return new Promise(() => {});
				},
				{ connection: { connectionString: url as string }, lockDuration: 300 },
				createPostgresBackend,
			);
			script({ parent: [say("retried")] });
			const id = await send("hi");
			await waitFor(async () => picked, Boolean);
			await crashing.close(true);

			stopWorker = await serve({ stalledInterval: 200 });
			await waitFor(
				() => get(id),
				(v) => v?.status === "failed",
			);
			await conversations.retry(userId, id);
			const view = await waitFor(
				() => get(id),
				(v) => v?.status === "idle",
			);
			expect(view?.messages.map((m) => m.message.role)).toEqual([
				"user",
				"assistant",
			]);
		}, 15_000);
	},
);
