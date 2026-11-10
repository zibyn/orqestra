import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { messageText, type OrqestraConfig, turnSkills } from "@orqestra/config";
import type { RunHandle } from "@orqestra/conversations";
import { type openToolbox, orrery as orreryClient } from "@orqestra/tools";
import { prepareContext } from "./compaction.ts";
import { memoryPrompt, memoryTools, recallTool } from "./memory.ts";
import { type SkillFiles, sandboxTools, skillsPrompt } from "./sandbox.ts";
import { generateTitle } from "./title.ts";
import {
	MAX_SUBAGENT_STEPS,
	relay,
	STEP_LIMIT,
	subagentTools,
} from "./tools.ts";

export type RuntimeDeps = {
	/** Subagent templates, the services for the Tools, and the Skills with the Sandbox Provider. */
	config: Pick<
		OrqestraConfig,
		"agents" | "tools" | "mcpServers" | "skills" | "sandboxProvider"
	>;
	/** Every Model request of the Run goes through it. */
	streamSimple: OrqestraConfig["streamSimple"];
	openToolbox: typeof openToolbox;
	/** A Skill version's files, written into the Sandbox. */
	skillFiles: SkillFiles;
	/** The Sandbox Provider's client; tests stand in for orrery. */
	orrery?: typeof orreryClient;
};

/**
 * Replies to one Run, step by step, until no input is left: the Agent loop, compaction and the title.
 * A failed reply throws, and the Run fails.
 */
export async function runAgent(
	run: RunHandle,
	{
		config,
		streamSimple,
		openToolbox,
		skillFiles,
		orrery = orreryClient,
	}: RuntimeDeps,
) {
	const { conversationId, turn, signal } = run;
	const sub = run.isSubagent;
	const rows = run.transcript.messages;
	const last = rows.at(-1) as (typeof rows)[number];
	// MCP Servers are connected for this Run only, so changes on the server side show up in the next one
	const toolbox = await openToolbox(config, turn.agent.tools, { signal });
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
			{ streamFn: streamSimple, signal },
		);
		if (compaction)
			await run.compacted(
				compaction.summary,
				compaction.firstKeptId,
				compaction.tokensBefore,
			);
		// a Subagent at the deepest level gets no Subagent Tools; every Subagent gets a step limit whose last request goes without Tools,
		// so it answers with what it has rather than stopping mid-search
		let steps = 0;
		const agent = new Agent({
			initialState: {
				systemPrompt:
					turn.agent.instructions + skillsPrompt(skills) + memoryBlock,
				model: turn.model,
				thinkingLevel: turn.thinking,
				tools: [
					...toolbox.tools,
					...sandbox,
					...(memory
						? [...memoryTools(memory, sub), recallTool(run.recall)]
						: []),
					...(run.subagents ? subagentTools(config, run.subagents) : []),
				],
				messages,
			},
			streamFn: streamSimple,
			sessionId: conversationId,
			finishTurn: () =>
				sub && ++steps >= MAX_SUBAGENT_STEPS ? { action: "end" } : undefined,
			// inputs that arrived during a step go to the model right after it
			prepareNextTurnWithContext: async ({ context }) => {
				const messages = await run.deliver();
				if (sub && steps === MAX_SUBAGENT_STEPS - 1)
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
			if (signal.aborted) return { outcome: "stopped" as const, result };
			if (steps >= MAX_SUBAGENT_STEPS)
				return { outcome: "partial" as const, result };
			return { outcome: "completed" as const, result };
		};

		signal.throwIfAborted(); // stopped before the reply began
		signal.addEventListener("abort", () => agent.abort());
		let next: Message[] = [];
		for (;;) {
			await (next.length ? agent.prompt(next) : agent.continue());
			const answer = agent.state.messages.at(-1) as AssistantMessage;
			// fails the job so the reason (e.g. an unreadable API key) is logged; the Run is then marked failed
			if (answer.stopReason === "error")
				throw new Error(answer.errorMessage ?? "The reply failed");
			next = await run.finish(sub ? ended() : undefined);
			if (!next.length) break;
		}
		if (sub) return;
		const answer = agent.state.messages.at(-1) as AssistantMessage;

		// titled after the first turn that produced a reply, stopped ones included
		const first = !rows.some((r) => r.message.role === "assistant");
		if (first && !run.renamed)
			await generateTitle(last.message, answer, turn.defaultModel, streamSimple)
				.then(async (title) => {
					if (title) await run.setTitle(title);
				})
				.catch((error) => console.error("title generation failed", error));
	} finally {
		await toolbox.close();
	}
}
