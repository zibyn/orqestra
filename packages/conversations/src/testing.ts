import type { Message } from "@earendil-works/pi-ai";
import type { ConnectionStore } from "@orqestra/mcp";
import type { Memory } from "@orqestra/memory";
import { inMemoryMemories } from "@orqestra/memory/testing";
import type { StreamSimple } from "@orqestra/models";
import type { SkillFile } from "@orqestra/skills/shared";
import { type ObjectStore, type Orrery, readySandbox } from "@orqestra/tools";
import { memoryStore } from "@orqestra/tools/testing";
import { type Counted, metered } from "./metered.ts";
import type { Recall } from "./recall.ts";
import type { Ended } from "./runs.ts";
import {
	type RunHandle,
	RunTimedOut,
	type StreamEvent,
	type Transcript,
	type Turn,
} from "./serve.ts";
import {
	MAX_TIMER_DELAY,
	MIN_TIMER_DELAY,
	TimerDelayOutOfRange,
	TimerLimitReached,
} from "./timers.ts";

const unavailable = async (): Promise<never> => {
	throw new Error("memoryRun has no Subagents: pass `subagents`");
};
const noModels: StreamSimple = () => {
	throw new Error("memoryRun has no Models: pass `streamSimple`");
};

/**
 * A RunHandle kept in memory, for testing a Run's handler without Postgres or BullMQ; same contract as the one `serveRuns` hands out.
 * `deliver` hands over the inputs `inbox` and `push` added, in order; `finish` returns those left, and the Run is over when there are none.
 * Records what the handler saved, streamed, compacted, titled and attached, and the Usage of its Model requests; attaching renames nothing.
 * Its Model requests are metered as `serveRuns`' are, against a Spending Limit of `spendingLimit` dollars for the Run.
 */
export function memoryRun({
	transcript,
	turn,
	scheduledTaskId,
	firingId,
	trace = { links: [] },
	inbox = [],
	isSubagent = false,
	unattended = false,
	incognito = false,
	titled = false,
	// a Subagent at the deepest level, as one is with the depth limit of 1, has none
	subagents = isSubagent
		? undefined
		: { start: unavailable, message: unavailable, stop: unavailable },
	timerRings = Number.POSITIVE_INFINITY,
	memories = [],
	memoryOff = false,
	recall = {
		search: async () => [],
		list: async () => [],
		open: async () => undefined,
	},
	attachments = {},
	streamSimple = noModels,
	spendingLimit = Number.POSITIVE_INFINITY,
	orrery,
	store = memoryStore().store,
	skillFiles = async () => [],
	connections,
}: {
	transcript: Transcript;
	turn: Turn;
	/** A Firing of this Scheduled Task started the Conversation. */
	scheduledTaskId?: string;
	firingId?: number;
	/** Where the Run's span goes; a root of its own by default, as for a User's message. */
	trace?: RunHandle["trace"];
	/** Inputs that arrive once the Run has begun. */
	inbox?: Message[];
	isSubagent?: boolean;
	unattended?: boolean;
	/** The Run's top-level Conversation is Incognito: the Run gets no Memories. */
	incognito?: boolean;
	/** The Conversation has a title, generated or the User's. */
	titled?: boolean;
	subagents?: RunHandle["subagents"];
	/** Timers that may still be set before TimerLimitReached. */
	timerRings?: number;
	/** The User's Memories as the Run begins. */
	memories?: Pick<Memory, "path" | "description" | "body">[];
	/** The User turned memory off: the Run gets no Memories. */
	memoryOff?: boolean;
	/** The Attachments the Run finds by name, with their object storage keys; none by default. */
	attachments?: Record<string, string>;
	/** The User's past Conversations; none by default. */
	recall?: Recall;
	/** The Models' streaming, which the Run's metered requests go through; none by default. */
	streamSimple?: StreamSimple;
	/** Dollars the Run's Model requests may cost before its Spending Limit is used up; no limit by default. */
	spendingLimit?: number;
	/** The Sandbox Provider's client the Conversation's Sandbox is in; no Sandbox without it. */
	orrery?: Orrery;
	/** Object storage, where the Attachments are kept; an empty one by default. */
	store?: ObjectStore;
	/** A Skill version's files; none by default. */
	skillFiles?: (versionId: number) => Promise<SkillFile[]>;
	/** The Users' Connections; none by default. */
	connections?: ConnectionStore;
}) {
	const { memories: userMemories, store: memoryPaths } =
		inMemoryMemories(memories);
	const usage: Counted[] = [];
	const pending = [...inbox];
	const stopper = new AbortController();
	const saved: Message[] = [];
	const streamed: StreamEvent[] = [];
	const compactions: {
		summary: string;
		firstKeptId: number;
		tokensBefore: number;
	}[] = [];
	const titles: string[] = [];
	const attached = new Map<string, Uint8Array>();
	const outcomes: (Ended | undefined)[] = [];
	const questions: boolean[] = [];
	let over = false;
	let sandboxId: string | null = null;
	let timer: { delay: number; note: string } | undefined;
	let rings = timerRings;
	const run: RunHandle = {
		conversationId: "memory",
		userId: "memory-user",
		rootConversationId: isSubagent ? "memory-root" : "memory",
		scheduledTaskId,
		firingId,
		trace,
		isSubagent,
		unattended,
		turn,
		transcript,
		titled,
		signal: stopper.signal,
		deliver: async () => pending.splice(0),
		save: async (message) => {
			saved.push(message);
		},
		attach: async (name, body) => {
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());
			attached.set(name, bytes);
			return { name, size: bytes.length };
		},
		stream: async (event) => {
			streamed.push(event);
		},
		compacted: async (summary, firstKeptId, tokensBefore) => {
			compactions.push({ summary, firstKeptId, tokensBefore });
		},
		finish: async (outcome, { question = false } = {}) => {
			outcomes.push(outcome);
			questions.push(question);
			const next = stopper.signal.aborted ? [] : pending.splice(0);
			over = !next.length;
			return next;
		},
		streamSimple: metered(streamSimple, {
			reached: async () =>
				usage.reduce((spent, u) => spent + u.cost, 0) >= spendingLimit,
			record: async (counted) => usage.push(counted),
		}),
		setTitle: async (title) => {
			titles.push(title);
		},
		sandbox: async () => {
			if (!orrery) throw new Error("No Sandbox Provider is configured");
			const ready = await readySandbox(
				orrery,
				{ url: "http://orrery", token: "t", cpu: 1, memory: 1 },
				async (replacing, create) => {
					if (!sandboxId || sandboxId === replacing) sandboxId = await create();
					return sandboxId;
				},
				{ signal: stopper.signal },
			);
			return { ...ready, client: orrery };
		},
		skillFiles,
		store,
		connections,
		attachment: async (name) =>
			Object.hasOwn(attachments, name) ? { key: attachments[name] } : undefined,
		memories: memoryOff || incognito ? undefined : userMemories,
		recall,
		timer: isSubagent
			? undefined
			: {
					set: async (delay, note) => {
						if (delay < MIN_TIMER_DELAY || delay > MAX_TIMER_DELAY)
							throw new TimerDelayOutOfRange(delay);
						if (rings-- <= 0) throw new TimerLimitReached(timerRings);
						timer = { delay, note };
						return new Date(Date.now() + delay * 1000);
					},
					cancel: async () => {
						const had = !!timer;
						timer = undefined;
						return had;
					},
				},
		subagents,
	};
	return {
		run,
		/** An input arriving while the Run goes. */
		push: (...messages: Message[]) => pending.push(...messages),
		/** Stops the Run, as the User would. */
		stop: () => stopper.abort(),
		/** Aborts an Unattended Run past its wall-clock time, as `serveRuns` does. */
		timeOut: () => stopper.abort(new RunTimedOut(1)),
		/** The last `finish` returned no input. */
		get over() {
			return over;
		},
		/** The Timer set, if any. */
		get timer() {
			return timer;
		},
		/** The Conversation's Sandbox, once `sandbox` created one. */
		get sandboxId() {
			return sandboxId;
		},
		saved,
		streamed,
		compactions,
		titles,
		/** The files the handler attached, by name. */
		attached,
		outcomes,
		/** Whether each `finish` ended on a Question to the User. */
		questions,
		/** The User's Memories, by path. */
		memories: memoryPaths,
		/** The Usage the Run's Model requests recorded, in order. */
		usage,
	};
}

/** For `createConversations` in a test that deletes no MCP Server. */
export const noMcpServerDeletes = {
	mcpServers: {
		write: () => Promise.reject(new Error("this test deletes no MCP Server")),
	},
	agents: {
		forget: () => Promise.reject(new Error("this test forgets no Tool")),
	},
};
