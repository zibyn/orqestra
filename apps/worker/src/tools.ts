import {
	Agent,
	type AgentEvent,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
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
import { and, type ConversationEvent, db, eq, inArray } from "@orqestra/db";
import { subagent } from "@orqestra/db/schema";

/** Subagents running at once in one Run; more wait their turn. */
export const MAX_SUBAGENTS = 4;
/** Tasks one subagent call may hand out. */
export const MAX_SUBAGENT_TASKS = 8;
/** Subagents one Run may start in all, so a parent cannot keep delegating forever. */
export const MAX_SUBAGENTS_PER_RUN = 16;
/** Model requests a Subagent may make; the last one, without Tools, is for its final answer. */
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

const GENERAL_WORKER =
	"You carry out one task for another agent, starting without any prior context. Work through it with the tools you have, then reply with a complete, self-contained answer: it is all the other agent will see.";
const STEP_LIMIT =
	"You have reached your step limit and can no longer use tools. Reply now with your final answer from what you have so far, saying what is left undone.";

type Status = (typeof subagent.$inferSelect)["status"];

/** A Subagent's state within its Run, as the parent Agent's Tools see it. */
interface Handle {
	number: number;
	status: Status;
	result: string;
	/** Set once it runs; until then messages wait in `inbox`. */
	agent?: Agent;
	inbox: Message[];
	stop: AbortController;
	/** Resolves once it has finished and its row is saved; never rejects. */
	done: Promise<void>;
	finished: boolean;
	/** Its result went back to the parent Agent already. */
	reported: boolean;
}

/** Marks a Conversation's unfinished Subagents stopped, for a Run that ended without closing them (a crashed worker). */
export const stopSubagents = (conversationId: string) =>
	db
		.update(subagent)
		.set({ status: "stopped" })
		.where(
			and(
				eq(subagent.conversationId, conversationId),
				inArray(subagent.status, ["queued", "running"]),
			),
		);

// a Subagent's output may come from any web page: it must not close the tag that frames it
const results = (handles: Handle[]) =>
	handles
		.map(
			(h) =>
				`<result subagent="${h.number}" status="${h.status}">\n${h.result.replaceAll("</result", "<\\/result")}\n</result>`,
		)
		.join("\n\n");

/**
 * The Tools an Agent delegates tasks to Subagents with during a Run: start them, wait for results, message or stop them.
 * Subagents work in the background, up to MAX_SUBAGENTS at once, with `tools` narrowed to their template's and none of these;
 * `close` stops the ones left once the Run's reply is done.
 */
export function subagentTools(
	config: OrqestraConfig,
	parent: { model: Model<Api>; thinking: ThinkingLevel },
	tools: AgentTool[],
	run: {
		conversationId: string;
		signal: AbortSignal;
		/** Sends the UI what streams and, after every saved change, what to reload. */
		notify: Notify;
	},
) {
	const limit = limiter(MAX_SUBAGENTS);
	const handles = new Map<number, Handle>();
	const templates = config.agents
		.map((a) => `- ${a.id} (${a.name}): ${a.description}`)
		.join("\n");

	async function save(
		id: string,
		values: Partial<typeof subagent.$inferInsert>,
		event: ConversationEvent = { type: "saved" },
	) {
		await db.update(subagent).set(values).where(eq(subagent.id, id));
		await run.notify(event);
	}

	async function work(
		id: string,
		h: Handle,
		brief: string,
		template: AgentDefinition | undefined,
		signal: AbortSignal,
	) {
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
				messages: [
					{ role: "user", content: brief, timestamp: Date.now() },
					...h.inbox,
				],
			},
			streamFn: config.streamSimple,
			finishTurn: () =>
				++steps >= MAX_SUBAGENT_STEPS ? { action: "end" } : undefined,
			// the last request goes without Tools, so it answers with what it has rather than stopping mid-search
			prepareNextTurnWithContext: ({ context }) =>
				steps === MAX_SUBAGENT_STEPS - 1
					? {
							context: { ...context, tools: [] },
							messages: [
								{ role: "user", content: STEP_LIMIT, timestamp: Date.now() },
							],
						}
					: undefined,
		});
		h.agent = agent;
		// the transcript starts with the system prompt and Tool list; keep only what happened
		const transcript = () =>
			(agent.state.messages as Message[]).filter(
				(m) =>
					m.role === "user" ||
					m.role === "assistant" ||
					m.role === "toolResult",
			);
		agent.subscribe(async (event) => {
			await relay(event, run.notify, id);
			if (event.type === "message_end")
				await save(
					id,
					{ messages: transcript() },
					event.message.role === "assistant"
						? { type: "end", subagent: id }
						: undefined,
				);
		});
		const abort = () => agent.abort();
		signal.addEventListener("abort", abort);
		try {
			await save(id, { status: "running" });
			h.status = "running";
			signal.throwIfAborted();
			await agent.continue();
		} finally {
			signal.removeEventListener("abort", abort);
		}
		const replies = transcript().filter(
			(m): m is AssistantMessage => m.role === "assistant",
		);
		const last = replies.at(-1);
		let result =
			replies
				.map(messageText)
				.filter((t) => t.trim())
				.at(-1) ?? "";
		let status: Status = "completed";
		if (last?.stopReason === "aborted" || signal.aborted) status = "stopped";
		else if (last?.stopReason === "error") {
			status = "failed";
			result += `\n\n[The subagent failed: ${last.errorMessage ?? "unknown error"}]`;
		} else if (steps >= MAX_SUBAGENT_STEPS) status = "partial";
		return { status, result, messages: transcript() };
	}

	function start(
		id: Promise<string>,
		h: Handle,
		brief: string,
		template: AgentDefinition | undefined,
	) {
		const signal = AbortSignal.any([run.signal, h.stop.signal]);
		return (async () => {
			const rowId = await id;
			const outcome = await limit(
				() => work(rowId, h, brief, template, signal),
				signal,
			).catch((error) =>
				// dropped while queued, or stopped before it began
				signal.aborted
					? { status: "stopped" as const, result: "" }
					: {
							status: "failed" as const,
							result: `[The subagent failed: ${error instanceof Error ? error.message : error}]`,
						},
			);
			h.status = outcome.status;
			h.result = outcome.result;
			h.finished = true;
			await save(rowId, outcome);
		})().catch((error) => {
			// the row could not be saved: the Run still gets an outcome
			console.error(`subagent ${h.number} failed`, error);
			if (!h.finished) h.status = "failed";
			h.finished = true;
		});
	}

	const numbers = Type.Array(Type.Integer({ minimum: 1 }), {
		description: "Subagent numbers, as the subagent Tool returned them",
	});
	const find = (n: number) => {
		const h = handles.get(n);
		if (!h) throw new Error(`There is no subagent ${n}`);
		return h;
	};
	const report = (finished: Handle[], running: Handle[]) => {
		for (const h of finished) h.reported = true;
		const still = running.length
			? `\n\nStill running: ${running.map((h) => h.number).join(", ")}.`
			: "";
		return {
			content: text(results(finished) + still),
			details: { numbers: finished.map((h) => h.number) },
		};
	};

	const spawn = tool({
		name: "subagent",
		label: "Subagent",
		description: `Start subagents on tasks. They work in the background, in parallel, from a blank context, so you can keep working; get their final answers with subagent_wait. Use them for self-contained work such as research. Each brief must contain everything the subagent needs, including the role it should take. Optionally pick a template by id; without one a general worker does the task. Wait for every subagent you need before your final answer: any still running then is stopped.\n\nTemplates:\n${templates}`,
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
			if (handles.size + tasks.length > MAX_SUBAGENTS_PER_RUN)
				throw new Error(
					`A reply may start at most ${MAX_SUBAGENTS_PER_RUN} subagents and ${handles.size} have been started: do the rest of the work yourself.`,
				);
			const picked = tasks.map((t) => {
				const template = config.agents.find((a) => a.id === t.template);
				if (t.template && !template)
					throw new Error(`There is no template "${t.template}"`);
				if (template && !template.allModels && !template.models.length)
					throw new Error(`Template "${t.template}" has no available Model`);
				return { brief: t.brief, template };
			});
			const first = handles.size + 1;
			// registered before the insert lands, so a subagent_wait in the same reply already sees them
			const rows = (async () =>
				db
					.insert(subagent)
					.values(
						picked.map((t, i) => ({
							conversationId: run.conversationId,
							toolCallId,
							number: first + i,
							template: t.template?.id,
							brief: t.brief,
						})),
					)
					.returning({ id: subagent.id }))();
			for (const [i, t] of picked.entries()) {
				const h: Handle = {
					number: first + i,
					status: "queued",
					result: "",
					inbox: [],
					stop: new AbortController(),
					done: Promise.resolve(),
					finished: false,
					reported: false,
				};
				handles.set(h.number, h);
				h.done = start(
					rows.then((r) => r[i].id),
					h,
					t.brief,
					t.template,
				);
			}
			await rows;
			await run.notify({ type: "saved" });
			const started = picked.map((_, i) => first + i);
			return {
				content: text(
					`Started subagent${started.length > 1 ? "s" : ""} ${started.join(", ")}.`,
				),
				details: { numbers: started },
			};
		},
	});

	const wait = tool({
		name: "subagent_wait",
		label: "Wait for subagents",
		description:
			"Wait until at least one of the given subagents (by default every one whose result you have not had yet) has finished, then return the results of all that have.",
		parameters: Type.Object({ numbers: Type.Optional(numbers) }),
		execute: async (_id, args) => {
			const targets = args.numbers?.length
				? args.numbers.map(find)
				: [...handles.values()].filter((h) => !h.reported);
			if (!targets.length)
				return {
					content: text("There are no subagents to wait for."),
					details: { numbers: [] },
				};
			if (!targets.some((h) => h.finished))
				await Promise.race(targets.map((h) => h.done));
			return report(
				targets.filter((h) => h.finished),
				targets.filter((h) => !h.finished),
			);
		},
	});

	const message = tool({
		name: "subagent_message",
		label: "Message subagent",
		description:
			"Send a running subagent more instructions or context; it reads them after its current step.",
		parameters: Type.Object({
			number: Type.Integer({ minimum: 1 }),
			message: Type.String(),
		}),
		execute: async (_id, { number, message }) => {
			const h = find(number);
			if (h.finished)
				throw new Error(
					`Subagent ${number} has finished; start a new one instead`,
				);
			const m: Message = {
				role: "user",
				content: message,
				timestamp: Date.now(),
			};
			if (h.agent) h.agent.steer(m);
			else h.inbox.push(m);
			return { content: text("Sent."), details: undefined };
		},
	});

	const stop = tool({
		name: "subagent_stop",
		label: "Stop subagents",
		description:
			"Stop subagents you no longer need, and return what each had produced.",
		parameters: Type.Object({ numbers }),
		execute: async (_id, args) => {
			const targets = args.numbers.map(find);
			for (const h of targets) h.stop.abort();
			await Promise.all(targets.map((h) => h.done));
			return report(targets, []);
		},
	});

	return {
		tools: [spawn, wait, message, stop],
		/** Stops the Subagents still running and waits until their rows are saved. */
		close: async () => {
			for (const h of handles.values()) if (!h.finished) h.stop.abort();
			await Promise.all([...handles.values()].map((h) => h.done));
		},
	};
}
