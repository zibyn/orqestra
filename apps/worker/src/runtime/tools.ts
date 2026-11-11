import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { Limits, OrqestraConfig } from "@orqestra/config";
import {
	BudgetExceeded,
	checkSchedule,
	MAX_SUBAGENT_TASKS,
	MAX_TIMER_DELAY,
	MIN_TIMER_DELAY,
	NoSuchSubagent,
	NoSuchTemplate,
	type RunHandle,
	type StreamEvent,
	TaskError,
	TemplateOffline,
	TimerLimitReached,
} from "@orqestra/conversations";

/** Model requests a Subagent may make; the last one, without Tools, is for its final answer. */
export const MAX_SUBAGENT_STEPS = 20;

const text = (t: string) => [{ type: "text" as const, text: t }];

// infers `execute`'s params from `parameters`, then fits the Agent's untyped Tool list
const tool = <T extends TSchema>(t: AgentTool<T>) => t as unknown as AgentTool;

/** Relays an Agent's reply as it streams. */
export async function relay(
	event: AgentEvent,
	stream: (event: StreamEvent) => Promise<void>,
) {
	if (event.type === "message_start" && event.message.role === "assistant")
		await stream({ type: "start" });
	if (event.type !== "message_update") return;
	const e = event.assistantMessageEvent;
	if (e.type === "text_delta" || e.type === "thinking_delta")
		await stream({
			type: "delta",
			kind: e.type === "text_delta" ? "text" : "thinking",
			index: e.contentIndex,
			delta: e.delta,
		});
}

/**
 * The top-level Agent's Tool for asking the User a Question: the Run ends after the step that asked, awaiting their reply.
 * Once per Turn; `asked` says whether this Turn asked, and `reset` starts the next one.
 */
export function questionTool() {
	let asked = false;
	const ask = tool({
		name: "ask_user",
		label: "Ask the user",
		description:
			"Ask the user a question you cannot go on without, and end your reply: their answer comes as their next message. At most once per reply. Offer a few likely answers as suggestions when there are some; the user may always answer in their own words.",
		parameters: Type.Object({
			question: Type.String(),
			suggestions: Type.Optional(
				Type.Array(Type.String(), { minItems: 2, maxItems: 4 }),
			),
		}),
		execute: async () => {
			if (asked)
				throw new Error(
					"You already asked the user a question in this reply: wait for their answer.",
				);
			asked = true;
			return {
				content: text("Asked. The user's answer comes as their next message."),
				details: undefined,
			};
		},
	});
	return {
		tool: ask,
		get asked() {
			return asked;
		},
		reset() {
			asked = false;
		},
	};
}

/** The top-level Agent's Tools for coming back to the Conversation later: set its one Timer, or cancel it. */
export function timerTools(timer: NonNullable<RunHandle["timer"]>) {
	const set = tool({
		name: "set_timer",
		label: "Set a timer",
		description: `Come back to this conversation later, such as to check on a long command or an outside result: after \`delay\` seconds (${MIN_TIMER_DELAY} to ${MAX_TIMER_DELAY}, a minute to a day) \`note\` comes to you as an input, and you carry on from there without the user. Write the note to yourself, saying what to check and why. The conversation has one timer: setting one replaces the last. The user sees when it rings and may cancel it.`,
		parameters: Type.Object({
			delay: Type.Integer({
				minimum: MIN_TIMER_DELAY,
				maximum: MAX_TIMER_DELAY,
				description: "Seconds from now",
			}),
			note: Type.String({ minLength: 1 }),
		}),
		execute: async (_, { delay, note }) => {
			const ringsAt = await timer.set(delay, note).catch((error) => {
				throw error instanceof TimerLimitReached
					? new Error(
							`Since the user's last message the timer has rung ${error.max} times, the most it may: set no more, end your reply and tell the user what is left.`,
						)
					: error;
			});
			return {
				content: text(`The timer rings at ${ringsAt.toISOString()}.`),
				details: undefined,
			};
		},
	});
	const cancel = tool({
		name: "cancel_timer",
		label: "Cancel the timer",
		description: "Cancel the timer you set, if it has yet to ring.",
		parameters: Type.Object({}),
		execute: async () => ({
			content: text(
				(await timer.cancel()) ? "Cancelled." : "No timer was set.",
			),
			details: undefined,
		}),
	});
	return [set, cancel];
}

// an ISO time's trailing offset: Z or ±hh:mm
const OFFSET = /(Z|[+-]\d\d:\d\d)$/i;

/**
 * The top-level Agent's Tool for drafting a Scheduled Task: checked as a saved one would be, then shown to the User
 * as a card they may open and create from; nothing is saved, and the Run goes on.
 */
export function draftTool(limits: Pick<Limits, "minFiringInterval">) {
	return tool({
		name: "draft_scheduled_task",
		label: "Draft a scheduled task",
		description: `Draft a scheduled task for the user: they see it as a card and decide whether to create it. On each run, \`prompt\` is sent to a new conversation as the user's message, with no one watching, so write it to stand on its own. A schedule runs once at an ISO time with its UTC offset, every so many seconds, or by a 5-field cron expression read in the user's time zone; runs must be at least ${limits.minFiringInterval} seconds apart. \`ends_at\` (ISO, with its offset) ends a recurring one.`,
		parameters: Type.Object({
			name: Type.String({ minLength: 1, maxLength: 100 }),
			prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
			schedule: Type.Union([
				Type.Object({ kind: Type.Literal("once"), at: Type.String() }),
				Type.Object({
					kind: Type.Literal("every"),
					seconds: Type.Integer({ minimum: 1 }),
				}),
				Type.Object({ kind: Type.Literal("cron"), expr: Type.String() }),
			]),
			ends_at: Type.Optional(Type.String()),
		}),
		execute: async (_, { schedule, ends_at }) => {
			// a time without its offset would be read in the worker's time zone, not the user's
			for (const [field, time] of [
				["schedule.at", schedule.kind === "once" ? schedule.at : undefined],
				["ends_at", ends_at],
			])
				if (time !== undefined && !OFFSET.test(time))
					throw new Error(
						`${field}: give the time with its UTC offset, such as 2026-01-31T09:00:00+08:00`,
					);
			try {
				// shortcut: cron and intervals are checked in UTC, though the User saves them in their browser's time zone; only DST shifts a cron's intervals
				checkSchedule(limits, {
					schedule,
					endsAt: ends_at ?? null,
					timeZone: "UTC",
				});
			} catch (error) {
				throw error instanceof TaskError
					? new Error(`${error.field}: ${error.message}`)
					: error;
			}
			return {
				content: text(
					"The draft is shown to the user, who has not created it yet: they may open it and create it.",
				),
				details: undefined,
			};
		},
	});
}

/** The Tool result of a call its MCP Server put in the background, as Background Call `id`. */
export const backgrounded = (id: string) => ({
	content: text(
		"The call started in the background. Its result comes to you by itself as a <task-notification> once it ends: do not poll for it or call the tool again. Until it is in, you may go on with other work, or tell the user what you are doing and end your reply.",
	),
	details: { backgroundCall: id },
});

/** Told to a Subagent whose next request is its last, made without Tools. */
export const STEP_LIMIT =
	"You have reached your step limit and can no longer use tools. Reply now with your final answer from what you have so far, saying what is left undone.";

const NOTIFIED =
	"Each subagent's final answer comes to you by itself as a <task-notification>, once it finishes: do not poll. Until the results you need are in, you may tell the user what you are doing and end your reply.";

/** What the model is told when its Subagent request is refused. */
function refusal(error: unknown) {
	if (error instanceof BudgetExceeded)
		return new Error(
			`Since the user's last message at most ${error.max} subagents may be started or continued, and ${error.used} have been: do the rest of the work yourself.`,
		);
	if (
		error instanceof NoSuchSubagent ||
		error instanceof NoSuchTemplate ||
		error instanceof TemplateOffline
	)
		return new Error(error.message);
	return error;
}

/**
 * The Tools an Agent delegates tasks to Subagents with: start them, message (or continue) them, stop them.
 * Each Subagent works in the background, past the parent's Run; it hands back its result as a Notification that wakes the parent.
 */
export function subagentTools(
	config: Pick<OrqestraConfig, "agents">,
	subagents: NonNullable<RunHandle["subagents"]>,
) {
	const templates = config.agents
		.map((a) => `- ${a.id} (${a.name}): ${a.description}`)
		.join("\n");
	// a refusal goes to the model as the Tool's error
	const refused = (error: unknown): never => {
		throw refusal(error);
	};

	const spawn = tool({
		name: "subagent",
		label: "Subagent",
		description: `Start subagents on tasks. They work in the background, in parallel, from a blank context, so you can keep working. Use them for self-contained work such as research. Each brief must contain everything the subagent needs, including the role it should take. Optionally pick a template by id; without one a general worker does the task. ${NOTIFIED}\n\nTemplates:\n${templates}`,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					brief: Type.String({
						description: "The complete task, with all needed context",
					}),
					template: Type.Optional(
						Type.String({ description: "A template id from the list" }),
					),
				}),
				{ minItems: 1, maxItems: MAX_SUBAGENT_TASKS },
			),
		}),
		execute: async (toolCallId, { tasks }) => {
			const started = await subagents.start(toolCallId, tasks).catch(refused);
			return {
				content: text(
					`Started subagent${started.length > 1 ? "s" : ""} ${started.join(", ")}.`,
				),
				details: { numbers: started },
			};
		},
	});

	const message = tool({
		name: "subagent_message",
		label: "Message subagent",
		description: `Send a subagent more instructions or context. A running one reads them after its current step; a finished one continues where it left off, and notifies you again when done.`,
		parameters: Type.Object({
			number: Type.Integer({ minimum: 1 }),
			message: Type.String(),
		}),
		execute: async (_id, { number, message }) => {
			const { continued } = await subagents
				.message(number, message)
				.catch(refused);
			return {
				content: text(continued ? `Subagent ${number} continues.` : "Sent."),
				details: undefined,
			};
		},
	});

	const stop = tool({
		name: "subagent_stop",
		label: "Stop subagents",
		description:
			"Stop subagents you no longer need. Each one stopped notifies you with what it had produced.",
		parameters: Type.Object({
			numbers: Type.Array(Type.Integer({ minimum: 1 }), {
				description: "Subagent numbers, as the subagent Tool returned them",
			}),
		}),
		execute: async (_id, { numbers }) => {
			const stopped = await subagents.stop(numbers).catch(refused);
			return {
				content: text(
					stopped.length
						? `Stopping subagent${stopped.length > 1 ? "s" : ""} ${stopped.join(", ")}.`
						: "None of them was running.",
				),
				details: { numbers: stopped },
			};
		},
	});

	return [spawn, message, stop];
}
