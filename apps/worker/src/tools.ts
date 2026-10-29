import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type TSchema,
	Type,
} from "@earendil-works/pi-ai";
import {
	type AgentDefinition,
	messageText,
	type OrqestraConfig,
	resolveTurn,
	type ThinkingLevel,
} from "@orqestra/config";
import { scrape, search } from "@orqestra/config/search";

/** Subagents running at once in one Run; more wait their turn. */
export const MAX_SUBAGENTS = 4;
/** Tasks one subagent call may hand out. */
export const MAX_SUBAGENT_TASKS = 8;
/** Model requests a Subagent may make before it has to hand back what it has. */
export const MAX_SUBAGENT_STEPS = 20;
// shortcut: a hard cut keeps one page from flooding the context; summarize instead if pages get cut too often
const MAX_PAGE_CHARS = 50_000;

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
							page.length > MAX_PAGE_CHARS
								? `${page.slice(0, MAX_PAGE_CHARS)}\n\n[The page was cut off here.]`
								: page,
						),
						details: undefined,
					};
				},
			}),
		);
	return tools;
}

const GENERAL_WORKER =
	"You carry out one task for another agent, starting without any prior context. Work through it with the tools you have, then reply with a complete, self-contained answer: it is all the other agent will see.";

/** One Subagent's whole process, kept in the subagent Tool result's details for the UI. */
export interface SubagentTranscript {
	/** Agent Definition id; undefined for the built-in general worker. */
	template?: string;
	brief: string;
	messages: Message[];
	result: string;
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

/**
 * The Tool an Agent delegates tasks to Subagents with, one per task, in parallel up to MAX_SUBAGENTS per Run.
 * Subagents get `tools` narrowed to their template's, and no subagent Tool of their own.
 */
export function subagentTool(
	config: OrqestraConfig,
	parent: { model: Model<Api>; thinking: ThinkingLevel },
	tools: AgentTool[],
): AgentTool {
	const limit = limiter(MAX_SUBAGENTS);
	const templates = config.agents
		.map((a) => `- ${a.id} (${a.name}): ${a.description}`)
		.join("\n");

	async function run(
		brief: string,
		template: AgentDefinition | undefined,
		signal?: AbortSignal,
	): Promise<SubagentTranscript> {
		// a template with its own Models runs on its default; otherwise the Subagent inherits the parent's
		const own =
			template && !template.allModels && resolveTurn(config, template.id);
		let steps = 0;
		const agent = new Agent({
			initialState: {
				systemPrompt: template?.instructions || GENERAL_WORKER,
				model: own ? own.model : parent.model,
				thinkingLevel: own ? own.thinking : parent.thinking,
				tools: template
					? tools.filter((t) =>
							template.tools.includes(
								t.name as AgentDefinition["tools"][number],
							),
						)
					: tools,
				messages: [{ role: "user", content: brief, timestamp: Date.now() }],
			},
			streamFn: config.streamSimple,
			finishTurn: () =>
				++steps >= MAX_SUBAGENT_STEPS ? { action: "end" } : undefined,
		});
		const abort = () => agent.abort();
		signal?.addEventListener("abort", abort);
		try {
			await agent.continue();
		} finally {
			signal?.removeEventListener("abort", abort);
		}
		// the transcript starts with the system prompt and Tool list; keep only what happened
		const messages = (agent.state.messages as Message[]).filter(
			(m) =>
				m.role === "user" || m.role === "assistant" || m.role === "toolResult",
		);
		const replies = messages.filter(
			(m): m is AssistantMessage => m.role === "assistant",
		);
		const last = replies.at(-1);
		let result =
			replies
				.map(messageText)
				.filter((t) => t.trim())
				.at(-1) ?? "";
		if (last?.stopReason === "error")
			result += `\n\n[The subagent failed: ${last.errorMessage ?? "unknown error"}]`;
		else if (steps >= MAX_SUBAGENT_STEPS)
			result += `\n\n[The subagent hit its step limit of ${MAX_SUBAGENT_STEPS}; this is a partial result.]`;
		return { template: template?.id, brief, messages, result };
	}

	return tool({
		name: "subagent",
		label: "Subagent",
		description: `Hand tasks to subagents, which work in parallel from a blank context and only return their final answers, keeping your context clean. Use it for self-contained work such as research. Each brief must contain everything the subagent needs, including the role it should take. Optionally pick a template by id; without one a general worker does the task.\n\nTemplates:\n${templates}`,
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
		execute: async (_id, { tasks }, signal) => {
			const picked = tasks.map((t) => {
				const template = config.agents.find((a) => a.id === t.template);
				if (t.template && !template)
					throw new Error(`There is no template "${t.template}"`);
				if (template && !template.allModels && !template.models.length)
					throw new Error(`Template "${t.template}" has no available Model`);
				return { brief: t.brief, template };
			});
			const runs = await Promise.all(
				picked.map((t) =>
					limit(() => run(t.brief, t.template, signal), signal),
				),
			);
			return {
				content: text(
					runs
						.map((r, i) => `<result task="${i + 1}">\n${r.result}\n</result>`)
						.join("\n\n"),
				),
				details: { subagents: runs },
			};
		},
	});
}
