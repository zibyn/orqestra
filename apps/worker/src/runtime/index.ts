import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
	NOOP_TELEMETRY_CONTEXT,
	type SpanAttributes,
	type TelemetryCarrier,
	type TelemetryContext,
	type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { messageText, type OrqestraConfig, turnSkills } from "@orqestra/config";
import {
	type RunHandle,
	RunTimedOut,
	SpendingLimitReached,
} from "@orqestra/conversations";
import {
	type ObjectStore,
	type openToolbox,
	orrery as orreryClient,
} from "@orqestra/tools";
import { prepareContext } from "./compaction.ts";
import { memoryPrompt, memoryTools, recallTool } from "./memory.ts";
import { type SkillFiles, sandboxTools, skillsPrompt } from "./sandbox.ts";
import { generateTitle } from "./title.ts";
import {
	backgrounded,
	draftTool,
	MAX_SUBAGENT_STEPS,
	questionTool,
	refusal,
	relay,
	STEP_LIMIT,
	subagentTools,
	timerTools,
} from "./tools.ts";

export type RuntimeDeps = {
	/** Subagent templates, the services for the Tools, and the Skills with the Sandbox Provider. */
	config: Pick<
		OrqestraConfig,
		"agents" | "tools" | "mcpServers" | "skills" | "sandboxProvider" | "limits"
	>;
	/** Every Model request of the Run goes through it, each saying what it is for. */
	streamSimple: (
		purpose: Parameters<RunHandle["recordUsage"]>[0],
	) => OrqestraConfig["streamSimple"];
	openToolbox: typeof openToolbox;
	/** A Skill version's files, written into the Sandbox. */
	skillFiles: SkillFiles;
	/** The Sandbox Provider's client; tests stand in for orrery. */
	orrery?: typeof orreryClient;
	/** Object storage, where Attachments are kept; Parse reads them there. No Parse without it. */
	store?: ObjectStore;
	/** Where the Run's spans go; nowhere by default. */
	telemetry?: TelemetryContext;
};

/** Whose a span is: on every span of the Run, never a name, an email or a title. */
const runAttributes = (run: RunHandle): SpanAttributes => ({
	"user.id": run.userId,
	"gen_ai.agent.id": run.turn.agent.id,
	"gen_ai.conversation.id": run.conversationId,
	"orqestra.conversation.root_id": run.rootConversationId,
	"orqestra.scheduled_task.id": run.scheduledTaskId,
	"orqestra.firing.id": run.firingId,
});

/** `span`, its children starting with `attributes` too. */
const withAttributes = (
	span: TelemetrySpan,
	attributes: SpanAttributes,
): TelemetrySpan => ({
	metrics: span.metrics,
	propagation: span.propagation,
	startSpan: (options, callback) =>
		span.startSpan(
			{ ...options, attributes: { ...attributes, ...options.attributes } },
			callback,
		),
	addLink: (link) => span.addLink(link),
	addEvent: (name, attributes) => span.addEvent(name, attributes),
	setAttributes: (attributes) => span.setAttributes(attributes),
	setStatus: (status) => span.setStatus(status),
});

/**
 * `tool`, each call a span of its own under `span`: the Tool's name, its call id and whether it failed, never its
 * arguments or result. A thrown error is `_OTHER` (the adapter's default); a result that is an error, MCP's `isError`
 * included, is `tool_error`. While a call runs, `carriers` holds its span's trace context by call id, for the work it sets going.
 */
const traced =
	(span: TelemetrySpan, carriers: Map<string, TelemetryCarrier>) =>
	(tool: AgentTool & { mcpServerId?: string }): AgentTool => ({
		...tool,
		execute: (toolCallId, ...rest) =>
			span.startSpan(
				{
					name: `execute_tool ${tool.name}`,
					attributes: {
						"gen_ai.operation.name": "execute_tool",
						"gen_ai.tool.name": tool.name,
						"gen_ai.tool.call.id": toolCallId,
						"orqestra.mcp_server.id": tool.mcpServerId,
					},
				},
				async (toolSpan) => {
					const carrier = toolSpan.propagation?.inject(toolSpan);
					if (carrier) carriers.set(toolCallId, carrier);
					try {
						const result = await tool.execute(toolCallId, ...rest);
						if (result.isError)
							toolSpan.setStatus({
								status: "error",
								error: { name: "tool_error", message: "" },
							});
						return result;
					} finally {
						carriers.delete(toolCallId);
					}
				},
			),
	});

/** What a Run is for, on its span and its Tool calls'. */
const runPurpose = (run: RunHandle) =>
	run.isSubagent ? "subagent" : run.firingId === undefined ? "turn" : "firing";

/**
 * Replies to one Run, step by step, until no input is left: the Agent loop, compaction and the title.
 * A failed reply throws, and the Run fails.
 */
export function runAgent(
	run: RunHandle,
	{ telemetry = NOOP_TELEMETRY_CONTEXT, ...deps }: RuntimeDeps,
) {
	const attributes = runAttributes(run);
	const { propagation } = telemetry;
	// a Subagent's first Run goes under the Tool call that started it; a woken one is a root, linked to what woke it
	const parent =
		run.trace.parent && propagation
			? propagation.extract(run.trace.parent)
			: telemetry;
	return parent.startSpan(
		{
			name: "invoke_agent",
			attributes: {
				...attributes,
				"orqestra.purpose": runPurpose(run),
				"orqestra.run.unattended": run.unattended,
				"orqestra.run.subagent": run.isSubagent,
			},
			links: propagation
				? run.trace.links.map((c) => ({ context: propagation.extract(c) }))
				: [],
		},
		(span) =>
			reply(run, {
				...deps,
				span,
				// every Model request of the Run is a child of its span, saying what it is for
				streamSimple: (purpose) => {
					const streamSimple = deps.streamSimple(purpose);
					const telemetry = withAttributes(span, {
						...attributes,
						"orqestra.purpose": purpose,
					});
					return (model, context, options) =>
						streamSimple(model, context, { ...options, telemetry });
				},
			}),
	);
}

async function reply(
	run: RunHandle,
	{
		config,
		streamSimple,
		openToolbox,
		skillFiles,
		orrery = orreryClient,
		store,
		span,
	}: Omit<RuntimeDeps, "telemetry"> & { span: TelemetrySpan },
) {
	const { conversationId, turn, signal } = run;
	const sub = run.isSubagent;
	let steps = 0;
	// why the Run failed, for its span: a closed set, never the error's text
	let failure = "_OTHER";
	const rows = run.transcript.messages;
	const last = rows.at(-1) as (typeof rows)[number];
	const provider = config.sandboxProvider;
	// the trace context of each Tool call under way, handed to the Subagents it starts or continues
	const carriers = new Map<string, TelemetryCarrier>();
	// MCP Servers are connected for this Run only, so changes on the server side show up in the next one
	const background = run.backgroundCalls;
	const toolbox = await openToolbox(config, turn.agent.tools, {
		signal,
		backgroundCall:
			background &&
			(async (call) =>
				backgrounded(
					await background.start(call).catch((error) => {
						throw refusal(error);
					}),
				)),
		files: store && {
			store,
			attachment: (name) => run.attachment(name),
			// beside the Attachment's copy, so the Agent can search the whole document with bash
			toSandbox:
				provider &&
				(async (path, markdown) => {
					const client = orrery(provider);
					const { id } = await run.sandbox(client, provider);
					await client.writeFile(id, path, new TextEncoder().encode(markdown), {
						signal,
					});
				}),
		},
	});
	// no Sandbox or Sandbox Tools without a Sandbox Provider; no Skill list without an available Skill
	const skills = turnSkills(config, turn.agent);
	const sandbox = config.sandboxProvider
		? sandboxTools(run, config.sandboxProvider, skills, {
				orrery,
				skillFiles,
			})
		: [];
	// a Subagent only reads; none when the User turned memory off; the Index is a snapshot, so writes during the Run leave the prompt (and its cache) alone
	const memory = turn.agent.memory ? run.memories : undefined;
	try {
		const memoryBlock = memory ? memoryPrompt(await memory.index(), sub) : "";
		const { messages, compaction } = await prepareContext(
			run.transcript,
			turn.model,
			turn.agent.compaction,
			{ streamFn: streamSimple("compaction"), signal },
		);
		if (compaction)
			await run.compacted(
				compaction.summary,
				compaction.firstKeptId,
				compaction.tokensBefore,
			);
		// a Subagent at the deepest level gets no Subagent Tools; every Subagent and an Unattended Run get a step limit
		// whose last request goes without Tools, so they answer with what they have rather than stopping mid-search
		const maxSteps = sub
			? MAX_SUBAGENT_STEPS
			: run.unattended
				? config.limits.unattendedMaxSteps
				: Number.POSITIVE_INFINITY;
		// what a step's request threw, such as SpendingLimitReached, which pi turns into a failed reply
		const step = streamSimple("step");
		let refused: unknown;
		// only the top-level Agent asks the User; the step that asked ends the Run
		const question = questionTool();
		const agent = new Agent({
			initialState: {
				systemPrompt:
					turn.agent.instructions + skillsPrompt(skills) + memoryBlock,
				model: turn.model,
				thinkingLevel: turn.thinking,
				// every Tool call is a child of the Run's span
				tools: [
					...toolbox.tools,
					...sandbox,
					...(memory
						? [...memoryTools(memory, sub), recallTool(run.recall)]
						: []),
					...(run.subagents
						? subagentTools(config, run.subagents, (id) => carriers.get(id))
						: []),
					...(sub ? [] : [question.tool, draftTool(config.limits)]),
					...(run.timer ? timerTools(run.timer) : []),
				].map(
					traced(
						withAttributes(span, {
							...runAttributes(run),
							"orqestra.purpose": runPurpose(run),
						}),
						carriers,
					),
				),
				messages,
			},
			streamFn: async (...request) => {
				try {
					return await step(...request);
				} catch (error) {
					refused = error;
					throw error;
				}
			},
			sessionId: conversationId,
			finishTurn: () =>
				++steps >= maxSteps || question.asked ? { action: "end" } : undefined,
			// inputs that arrived during a step go to the model right after it
			prepareNextTurnWithContext: async ({ context }) => {
				const messages = await run.deliver();
				if (steps === maxSteps - 1)
					return {
						context: { ...context, tools: [] },
						messages: [
							...messages,
							{ role: "user", content: STEP_LIMIT, timestamp: Date.now() },
						],
					};
				return messages.length ? { messages } : undefined;
			},
		});
		agent.subscribe(async (event) => {
			await relay(event, run.stream);
			if (event.type !== "message_end") return;
			const { role } = event.message;
			if (role !== "toolResult" && role !== "assistant") return;
			// finished and stopped replies are saved (a stopped one keeps what was generated), and so are Tool results;
			// failed replies are not, the turn is retried instead, dropping everything after the user message
			if (role === "toolResult" || event.message.stopReason !== "error")
				await run.save(event.message);
		});

		// how the Run ended, judged from its last reply
		const ended = () => {
			const replies = (agent.state.messages as Message[]).filter(
				(m): m is AssistantMessage => m.role === "assistant",
			);
			const result =
				replies
					.map(messageText)
					.filter((t) => t.trim())
					.at(-1) ?? "";
			// out of time is no stop of the User's: what it has is a partial result
			if (signal.aborted)
				return {
					outcome:
						signal.reason instanceof RunTimedOut
							? ("partial" as const)
							: ("stopped" as const),
					result,
				};
			if (steps >= maxSteps) return { outcome: "partial" as const, result };
			return { outcome: "completed" as const, result };
		};

		signal.throwIfAborted(); // stopped before the reply began
		signal.addEventListener("abort", () => agent.abort());
		let next: Message[] = [];
		for (;;) {
			await (next.length ? agent.prompt(next) : agent.continue());
			const answer = agent.state.messages.at(-1) as AssistantMessage;
			// fails the job so the reason (e.g. an unreadable API key) is logged; the Run is then marked failed
			if (answer.stopReason === "error") {
				if (!(refused instanceof SpendingLimitReached))
					failure = "model_request_failed";
				throw refused ?? new Error(answer.errorMessage ?? "The reply failed");
			}
			next = await run.finish(sub || run.unattended ? ended() : undefined, {
				question: question.asked,
			});
			if (!next.length) break;
			question.reset();
		}
		span.setAttributes({ "orqestra.run.outcome": ended().outcome });
		if (sub) return;
		// a Question leaves its Tool result last
		const answer = (agent.state.messages as Message[])
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.at(-1) as AssistantMessage;

		// titled after any Turn while it has no title, stopped ones included, so one the Spending Limit put off comes later
		if (!run.titled)
			await generateTitle(
				last.message,
				answer,
				turn.defaultModel,
				streamSimple("title"),
			)
				.then(async (title) => {
					if (title) await run.setTitle(title);
				})
				.catch((error) => {
					// skipped this time: the next Turn tries again
					if (!(error instanceof SpendingLimitReached))
						console.error("title generation failed", error);
				});
	} catch (error) {
		// a stopped or timed-out Run is no error
		if (signal.aborted)
			span.setAttributes({
				"orqestra.run.outcome":
					signal.reason instanceof RunTimedOut ? "partial" : "stopped",
			});
		else {
			span.setAttributes({ "orqestra.run.outcome": "failed" });
			span.setStatus({
				status: "error",
				error: {
					name:
						error instanceof SpendingLimitReached
							? "spending_limit_reached"
							: failure,
					message: "",
				},
			});
		}
		throw error;
	} finally {
		span.setAttributes({ "orqestra.run.steps": steps });
		await toolbox.close();
	}
}
