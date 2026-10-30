import type { Message } from "@earendil-works/pi-ai";
import type { Ended } from "./runs.ts";
import type { RunHandle, StreamEvent, Transcript, Turn } from "./serve.ts";

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
	renamed = false,
	subagents = { start: unavailable, message: unavailable, stop: unavailable },
}: {
	transcript: Transcript;
	turn: Turn;
	/** Inputs that arrive once the Run has begun. */
	inbox?: Message[];
	isSubagent?: boolean;
	renamed?: boolean;
	subagents?: RunHandle["subagents"];
}) {
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
	let over = false;
	const run: RunHandle = {
		conversationId: "memory",
		isSubagent,
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
		finish: async (outcome) => {
			outcomes.push(outcome);
			const next = stopper.signal.aborted ? [] : pending.splice(0);
			over = !next.length;
			return next;
		},
		setTitle: async (title) => {
			if (!renamed) titles.push(title);
		},
		subagents,
	};
	return {
		run,
		/** An input arriving while the Run goes. */
		push: (...messages: Message[]) => pending.push(...messages),
		/** Stops the Run, as the User would. */
		stop: () => stopper.abort(),
		/** The last `finish` returned no input. */
		get over() {
			return over;
		},
		saved,
		streamed,
		compactions,
		titles,
		outcomes,
	};
}
