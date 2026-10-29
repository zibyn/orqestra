import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { AgentDefinition, OrqestraConfig } from "@orqestra/config";
import { scrape, search } from "@orqestra/config/search";
import {
	BudgetExceeded,
	MAX_SUBAGENT_TASKS,
	NoSuchSubagent,
	NoSuchTemplate,
	type RunHandle,
	type StreamEvent,
	TemplateOffline,
} from "@orqestra/conversations";

/** Model requests a Subagent may make; the last one, without Tools, is for its final answer. */
export const MAX_SUBAGENT_STEPS = 20;
// shortcut: a hard cut keeps one page or MCP Tool result from flooding the context; summarize instead if results get cut too often
export const MAX_TOOL_RESULT_CHARS = 50_000;

const text = (t: string) => [{ type: "text" as const, text: t }];

// infers `execute`'s params from `parameters`, then fits the Agent's untyped Tool list
const tool = <T extends TSchema>(t: AgentTool<T>) => t as unknown as AgentTool;

/** Search and Scrape, for those of `allowed` that have a Search Provider. */
export function searchTools(
	config: OrqestraConfig,
	allowed: AgentDefinition["tools"],
): AgentTool[] {
	const tools: AgentTool[] = [];
	const searchProvider = config.tools.search;
	if (searchProvider && allowed.includes("search"))
		tools.push(
			tool({
				name: "search",
				label: "Search",
				description:
					"Search the web. Returns matching pages with their title, URL and a snippet.",
				parameters: Type.Object({
					query: Type.String({ description: "What to search for" }),
					count: Type.Optional(
						Type.Integer({
							minimum: 1,
							maximum: 20,
							description: "How many results, 5 by default",
						}),
					),
				}),
				execute: async (_id, { query, count }, signal) => {
					const results = await search(
						searchProvider,
						query,
						count ?? 5,
						signal,
					);
					return {
						content: text(
							results
								.map((r) => `## ${r.title}\n${r.url}\n\n${r.snippet}`)
								.join("\n\n") || "No results.",
						),
						details: undefined,
					};
				},
			}),
		);
	const scrapeProvider = config.tools.scrape;
	if (scrapeProvider && allowed.includes("scrape"))
		tools.push(
			tool({
				name: "scrape",
				label: "Scrape",
				description: "Read one web page and return its content as Markdown.",
				parameters: Type.Object({
					url: Type.String({ description: "The page's http(s) URL" }),
				}),
				execute: async (_id, { url }, signal) => {
					const page = await scrape(scrapeProvider, url, signal);
					return {
						content: text(
							page.length > MAX_TOOL_RESULT_CHARS
								? `${page.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[The page was cut off here.]`
								: page,
						),
						details: undefined,
					};
				},
			}),
		);
	return tools;
}

/** Runs at most `max` functions at once, the rest in call order; one aborted while waiting leaves the queue and rejects. */
export function limiter(max: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return async <T>(fn: () => Promise<T>, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		if (active < max) active++;
		else
			await new Promise<void>((resolve, reject) => {
				const start = () => {
					signal?.removeEventListener("abort", stop);
					resolve();
				};
				const stop = () => {
					waiting.splice(waiting.indexOf(start), 1);
					reject(signal?.reason);
				};
				waiting.push(start);
				signal?.addEventListener("abort", stop, { once: true });
			});
		try {
			return await fn();
		} finally {
			// hand the slot straight to the next one, so no newcomer can slip in between
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

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
	config: OrqestraConfig,
	subagents: RunHandle["subagents"],
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
