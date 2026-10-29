import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type Model,
	type TSchema,
	Type,
} from "@earendil-works/pi-ai";
import {
	type AgentDefinition,
	modelRef,
	type OrqestraConfig,
	resolveTurn,
	type ThinkingLevel,
} from "@orqestra/config";
import { scrape, search } from "@orqestra/config/search";
import {
	type ConversationEvent,
	ensureRun,
	lockRoot,
	MAX_SUBAGENTS,
	stopSubagents,
} from "@orqestra/conversations/runs";
import { and, db, desc, eq, sql, type Tx } from "@orqestra/db";
import {
	conversation,
	inbox,
	message as messageRow,
	subagent,
} from "@orqestra/db/schema";

export { MAX_SUBAGENTS };
/** Tasks one subagent call may hand out. */
export const MAX_SUBAGENT_TASKS = 8;
/** Subagents an Agent may start or continue in all since the User's last message, so Notifications cannot keep it delegating forever. */
export const MAX_SUBAGENTS_PER_USER_MESSAGE = 16;
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

type Notify = (event: ConversationEvent) => Promise<unknown>;

/** Relays an Agent's reply as it streams; `subagent` (the row id) marks a Subagent's. */
export async function relay(
	event: AgentEvent,
	notify: Notify,
	subagent?: string,
) {
	if (event.type === "message_start" && event.message.role === "assistant")
		await notify({ type: "start", subagent });
	if (event.type !== "message_update") return;
	const e = event.assistantMessageEvent;
	if (e.type === "text_delta" || e.type === "thinking_delta")
		await notify({
			type: "delta",
			kind: e.type === "text_delta" ? "text" : "thinking",
			index: e.contentIndex,
			delta: e.delta,
			subagent,
		});
}

/** Told to a Subagent whose next request is its last, made without Tools. */
export const STEP_LIMIT =
	"You have reached your step limit and can no longer use tools. Reply now with your final answer from what you have so far, saying what is left undone.";

const NOTIFIED =
	"Each subagent's final answer comes to you by itself as a <task-notification>, once it finishes: do not poll. Until the results you need are in, you may tell the user what you are doing and end your reply.";

/**
 * Under the parent's lock: spends `more` of the budget of Subagents started, or continued once finished, since the User's last message.
 * Throws, spending nothing, when it would run out.
 */
async function spend(tx: Tx, conversationId: string, more: number) {
	const [{ used }] = await tx
		.update(conversation)
		.set({
			subagentsSinceUser: sql`${conversation.subagentsSinceUser} + ${more}`,
		})
		.where(eq(conversation.id, conversationId))
		.returning({ used: conversation.subagentsSinceUser });
	if (used > MAX_SUBAGENTS_PER_USER_MESSAGE)
		throw new Error(
			`Since the user's last message at most ${MAX_SUBAGENTS_PER_USER_MESSAGE} subagents may be started or continued, and ${used - more} have been: do the rest of the work yourself.`,
		);
}

/**
 * The Tools an Agent delegates tasks to Subagents with: start them, message (or continue) them, stop them.
 * Each Subagent runs in a Conversation of its own, in the background and past the parent's Run, up to MAX_SUBAGENTS at once;
 * it hands back its result as a Notification that wakes the parent.
 */
export function subagentTools(
	config: OrqestraConfig,
	parent: { model: Model<Api>; thinking: ThinkingLevel },
	run: {
		conversationId: string;
		userId: string;
		/** Sends the UI what to reload. */
		notify: Notify;
	},
) {
	const templates = config.agents
		.map((a) => `- ${a.id} (${a.name}): ${a.description}`)
		.join("\n");
	const find = async (tx: Tx, number: number) => {
		const row = await tx.query.subagent.findFirst({
			where: and(
				eq(subagent.parentId, run.conversationId),
				eq(subagent.number, number),
			),
		});
		if (!row) throw new Error(`There is no subagent ${number}`);
		return row;
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
			const picked = tasks.map((t) => {
				const template = config.agents.find((a) => a.id === t.template);
				if (t.template && !template)
					throw new Error(`There is no template "${t.template}"`);
				if (template && !template.allModels && !template.models.length)
					throw new Error(`Template "${t.template}" has no available Model`);
				// a template with its own Models runs on its default; otherwise the Subagent inherits the parent's
				const own =
					template && !template.allModels && resolveTurn(config, template.id);
				return {
					brief: t.brief,
					template,
					model: own ? own.model : parent.model,
					thinking: own ? own.thinking : parent.thinking,
				};
			});
			const { first, children } = await db.transaction(async (tx) => {
				await lockRoot(tx, run.conversationId);
				await spend(tx, run.conversationId, picked.length);
				const [{ numbered }] = await tx
					.select({
						numbered: sql<number>`coalesce(max(${subagent.number}), 0)`,
					})
					.from(subagent)
					.where(eq(subagent.parentId, run.conversationId));
				const first = Number(numbered) + 1;
				const children = await tx
					.insert(conversation)
					.values(
						picked.map((t) => ({
							userId: run.userId,
							parentId: run.conversationId,
							agentId: t.template?.id ?? null,
						})),
					)
					.returning({ id: conversation.id });
				await tx.insert(subagent).values(
					picked.map((t, i) => ({
						conversationId: children[i].id,
						parentId: run.conversationId,
						toolCallId,
						number: first + i,
						template: t.template?.id,
						brief: t.brief,
					})),
				);
				await tx.insert(inbox).values(
					picked.map((t, i) => ({
						conversationId: children[i].id,
						message: { role: "user", content: t.brief, timestamp: Date.now() },
						model: modelRef(t.model),
						thinkingLevel: t.thinking,
						wake: true,
					})),
				);
				return { first, children };
			});
			// beyond MAX_SUBAGENTS they stay queued until one finishes
			for (const c of children) await ensureRun(c.id);
			await run.notify({ type: "saved" });
			const started = children.map((_, i) => first + i);
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
			const row = await db.transaction(async (tx) => {
				await lockRoot(tx, run.conversationId);
				const row = await find(tx, number);
				const continued = !["queued", "running"].includes(row.outcome);
				if (continued) {
					await spend(tx, run.conversationId, 1);
					// it waits for a slot like a new one, and a stop catches it while it waits
					await tx
						.update(subagent)
						.set({ outcome: "queued" })
						.where(eq(subagent.conversationId, row.conversationId));
				}
				// it continues on the Model it last used
				const [last] = await tx
					.select({
						model: messageRow.model,
						thinkingLevel: messageRow.thinkingLevel,
					})
					.from(messageRow)
					.where(eq(messageRow.conversationId, row.conversationId))
					.orderBy(desc(messageRow.id))
					.limit(1);
				await tx.insert(inbox).values({
					conversationId: row.conversationId,
					message: { role: "user", content: message, timestamp: Date.now() },
					model: last?.model ?? modelRef(parent.model),
					thinkingLevel: last?.thinkingLevel ?? parent.thinking,
					wake: true,
				});
				return { ...row, continued };
			});
			await ensureRun(row.conversationId);
			await run.notify({ type: "saved" });
			return {
				content: text(
					row.continued ? `Subagent ${number} continues.` : "Sent.",
				),
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
			await db.transaction(async (tx) => {
				for (const n of numbers) await find(tx, n);
			});
			const stopped = await stopSubagents(run.conversationId, numbers);
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
