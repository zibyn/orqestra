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
	MAX_SUBAGENTS_PER_USER_MESSAGE,
} = await import("./index.ts");
const runs = await import("./runs.ts");
const { memoryRun } = await import("./testing.ts");

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
	pickable: true,
	allModels: false,
	tools: ["search", "scrape"],
	unavailableModels: [],
});
const fauxAgent = agent("faux", "faux/faux-1");
const config = {
	agents: [fauxAgent, agent("small", "faux/faux-small")],
	models: faux.models,
	defaultAgent: fauxAgent,
} as unknown as OrqestraConfig;
const conversations = createConversations({ config: async () => config });
const userId = "u1";

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
type Step = (ctx: Ctx) => string | Call[] | Promise<string | Call[]>;

let queues: { parent: Step[]; sub: Step[] } = { parent: [], sub: [] };
/** Subagents run alongside their parent, so each Run takes the next step meant for whoever runs it. */
function script(steps: { parent: Step[]; sub?: Step[] }) {
	queues = { parent: [...steps.parent], sub: [...(steps.sub ?? [])] };
}
/** A handler that replaces the script for one test. */
let override: ((run: RunHandle) => Promise<void>) | undefined;

async function scripted(run: RunHandle) {
	if (override) return override(run);
	const seen = run.transcript.messages.map((m) => m.message);
	for (;;) {
		const step = (run.isSubagent ? queues.sub : queues.parent).shift();
		if (!step) throw new Error("No scripted step left");
		const reply = await step({ run, seen, toolCallId: "" });
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

const say =
	(text: string): Step =>
	() =>
		text;
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
			await run.subagents.start(
				toolCallId,
				briefs.map((brief) => ({ brief })),
			)
		).join(", ")}`,
});
const message = (number: number, text: string): Call => ({
	name: "subagent_message",
	run: async ({ run }) =>
		(await run.subagents.message(number, text)).continued
			? `Subagent ${number} continues.`
			: "Sent.",
});
const stopSubagents = (numbers: number[]): Call => ({
	name: "subagent_stop",
	run: async ({ run }) => `Stopping ${await run.subagents.stop(numbers)}`,
});
// a reply that never comes; it ends only when the Run is stopped
const hang: Step = ({ run }) =>
	new Promise((_, reject) =>
		run.signal.addEventListener("abort", () => reject(new Error("aborted"))),
	);
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
			await db.execute(sql`truncate "user" cascade`);
			await db
				.insert(schema.user)
				.values({ id: userId, name: "U", email: "u@x.io" });
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
								await run.subagents.start(toolCallId, [
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
								await run.subagents.start(toolCallId, [
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
							refused = await run.subagents
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
			const queue = runs.runQueue(true);
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

		it("answers a message left in the inbox when the User stops the Run", async () => {
			let sent: Promise<unknown> | undefined;
			script({
				parent: [
					async ({ run }) => {
						await run.stream({ type: "start" });
						await new Promise((r) =>
							run.signal.addEventListener("abort", r, { once: true }),
						);
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
			await runs.stopSubagents(parent.id, [1]);
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
			await conversations.retry(userId, id);
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

		it("hides a Conversation from everyone but its owner", async () => {
			script({ parent: [say("hi")] });
			const id = await send("hi");
			await db
				.insert(schema.user)
				.values({ id: "admin", name: "A", email: "a@x.io", role: "admin" });
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
