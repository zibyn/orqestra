import type { Message } from "@earendil-works/pi-ai";
import { readySandbox } from "@orqestra/tools";
import {
	checkMemory,
	MAX_GREP_RESULTS,
	MAX_MEMORIES,
	type Memories,
	type Memory,
	MemoryError,
	missing,
	replaceOnce,
	tooMany,
} from "./memories.ts";
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

/**
 * A RunHandle kept in memory, for testing a Run's handler without Postgres or BullMQ; same contract as the one `serveRuns` hands out.
 * `deliver` hands over the inputs `inbox` and `push` added, in order; `finish` returns those left, and the Run is over when there are none.
 * Records what the handler saved, streamed, compacted and titled.
 */
export function memoryRun({
	transcript,
	turn,
	inbox = [],
	isSubagent = false,
	unattended = false,
	incognito = false,
	renamed = false,
	// a Subagent at the deepest level, as one is with the depth limit of 1, has none
	subagents = isSubagent
		? undefined
		: { start: unavailable, message: unavailable, stop: unavailable },
	timerRings = Number.POSITIVE_INFINITY,
	memories = [],
	memoryOff = false,
	recall = { search: async () => [], open: async () => undefined },
}: {
	transcript: Transcript;
	turn: Turn;
	/** Inputs that arrive once the Run has begun. */
	inbox?: Message[];
	isSubagent?: boolean;
	unattended?: boolean;
	/** The Run's top-level Conversation is Incognito: the Run gets no Memories. */
	incognito?: boolean;
	renamed?: boolean;
	subagents?: RunHandle["subagents"];
	/** Timers that may still be set before TimerLimitReached. */
	timerRings?: number;
	/** The User's Memories as the Run begins. */
	memories?: Pick<Memory, "path" | "description" | "body">[];
	/** The User turned memory off: the Run gets no Memories. */
	memoryOff?: boolean;
	/** The User's past Conversations; none by default. */
	recall?: Recall;
}) {
	const { memories: userMemories, store } = inMemoryMemories(memories);
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
	const outcomes: (Ended | undefined)[] = [];
	const questions: boolean[] = [];
	let over = false;
	let sandboxId: string | null = null;
	let timer: { delay: number; note: string } | undefined;
	let rings = timerRings;
	const run: RunHandle = {
		conversationId: "memory",
		isSubagent,
		unattended,
		turn,
		transcript,
		renamed,
		signal: stopper.signal,
		deliver: async () => pending.splice(0),
		save: async (message) => {
			saved.push(message);
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
		setTitle: async (title) => {
			if (!renamed) titles.push(title);
		},
		sandbox: (client, provider) =>
			readySandbox(
				client,
				provider,
				async (replacing, create) => {
					if (!sandboxId || sandboxId === replacing) sandboxId = await create();
					return sandboxId;
				},
				{ signal: stopper.signal },
			),
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
		outcomes,
		/** Whether each `finish` ended on a Question to the User. */
		questions,
		/** The User's Memories, by path. */
		memories: store,
	};
}

/**
 * A User's Memories kept in memory, by path, with the same limits and errors as `memoriesOf` (a contract test runs both through the same scenarios);
 * `grep` uses JavaScript's regular expressions rather than Postgres's.
 */
export function inMemoryMemories(
	seed: Pick<Memory, "path" | "description" | "body">[] = [],
	conversationId = "memory",
) {
	const store = new Map<string, Memory>();
	const put = (m: Pick<Memory, "path" | "description" | "body">) =>
		store.set(m.path, { ...m, conversationId, updatedAt: new Date() });
	for (const m of seed) put(m);
	const get = (path: string) => {
		const m = store.get(path);
		if (!m) throw missing(path);
		return m;
	};
	// latest updated first: a Map keeps insertion order, and every write re-inserts
	const latest = () => [...store.values()].reverse();
	const memories: Memories = {
		index: async () =>
			latest().map(({ path, description }) => ({ path, description })),
		read: async (path) => store.get(path),
		write: async (path, description, body) => {
			checkMemory(path, description, body);
			const before = store.get(path);
			if (!before && store.size >= MAX_MEMORIES) throw tooMany();
			store.delete(path);
			put({ path, description, body });
			return { before };
		},
		edit: async (path, old, replacement) => {
			const before = get(path);
			const body = replaceOnce(before.body, old, replacement);
			checkMemory(path, before.description, body);
			store.delete(path);
			put({ ...before, body });
			return { before };
		},
		delete: async (path) => {
			const before = get(path);
			store.delete(path);
			return { before };
		},
		grep: async (pattern) => {
			let re: RegExp;
			try {
				re = new RegExp(pattern, "i");
			} catch (error) {
				throw new MemoryError(
					`Invalid regular expression: ${(error as Error).message}`,
				);
			}
			return latest()
				.filter((m) => [m.path, m.description, m.body].some((s) => re.test(s)))
				.slice(0, MAX_GREP_RESULTS);
		},
	};
	return { memories, store };
}
