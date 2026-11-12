import type { Message } from "@earendil-works/pi-ai";
import {
	type AgentDefinition,
	invokedSkill,
	modelRef,
	type OrqestraConfig,
	resolveThinking,
	resolveTurn,
	type SkillFile,
	skillBlock,
	skillInstructions,
	type ThinkingLevel,
	turnSkills,
} from "@orqestra/config";
import { db } from "@orqestra/db";
import {
	attachment,
	backgroundCall,
	compaction,
	conversation,
	inbox,
	message,
	subagent,
	timer,
} from "@orqestra/db/schema";
import { type Undone, undoChange } from "@orqestra/memory";
import {
	type ConnectionStore,
	type Fetch,
	type ObjectStore,
	orrery as orreryClient,
} from "@orqestra/tools";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import pg from "pg";
import { alerts } from "./alerts.ts";
import {
	askToCancel,
	cancelBackgroundCall,
	cancelStopped,
	cancelStoppedCalls,
	endBackgroundCallsOf,
	runningCalls,
} from "./background-calls.ts";
import {
	AGENT_RUNS_QUEUE,
	conversationChannel,
	drain,
	enqueue,
	ensureRun,
	lockRoot,
	newJobId,
	requestStop,
	runQueue,
	saved,
	stopFiring,
	stopSubagents,
} from "./runs.ts";
import { ensureSandbox } from "./sandbox.ts";
import { type RunHandler, type ServeOptions, serveRuns } from "./serve.ts";
import { SPENDING_LIMIT_USED_UP, spendingLimitStatus } from "./spending.ts";
import { tasksOf } from "./tasks.ts";
import { cancelTimer } from "./timers.ts";
import {
	copyAttachments,
	deleteObjects,
	storeAttachment,
	sweepUnsentAttachments,
	uploadPath,
} from "./uploads.ts";

export { MAX_UPLOAD_BYTES } from "@orqestra/config";
export {
	MAX_RECALL_RESULTS,
	MAX_SNIPPET,
	type Recall,
	type Recalled,
} from "./recall.ts";
export type { ConversationEvent, Ended } from "./runs.ts";
export {
	BudgetExceeded,
	MAX_SUBAGENTS,
	MAX_SUBAGENTS_PER_USER_MESSAGE,
	queueInput,
} from "./runs.ts";
export { ensureSandbox } from "./sandbox.ts";
export {
	MAX_SUBAGENT_TASKS,
	NoSuchSubagent,
	NoSuchTemplate,
	type RunHandle,
	type RunHandler,
	RunTimedOut,
	type StreamEvent,
	TemplateOffline,
	type TraceCarrier,
	type Transcript,
	type TranscriptMessage,
	type Turn,
} from "./serve.ts";
export {
	SpendingLimitReached,
	spendingLimitStatus,
	spendingMonth,
} from "./spending.ts";
export {
	checkSchedule,
	nextFirings,
	TaskError,
	type TaskInput,
} from "./tasks.ts";
export {
	MAX_TIMER_DELAY,
	MIN_TIMER_DELAY,
	TimerDelayOutOfRange,
	TimerLimitReached,
} from "./timers.ts";
export { UploadTooLarge } from "./uploads.ts";
export { summarizeUsage, type UsageQuery } from "./usage.ts";
export { listUsers, rememberUser, setSpendingLimit } from "./users.ts";

// The only module that reads and writes Conversations, their Inbox, messages, Subagents and compactions.
// The User's side takes the signed-in user's id everywhere: nobody else, Admins included, can see a Conversation.

/** A request the User may not make as it stands; `field` and `code` say why, for the api's error body. */
export class ConversationError extends Error {
	override name = "ConversationError";
	constructor(
		message: string,
		readonly field: string,
		readonly code: string,
	) {
		super(message);
	}
}

const owned = (userId: string, id: string) =>
	db.query.conversation.findFirst({
		where: and(eq(conversation.id, id), eq(conversation.userId, userId)),
	});

/** The parent's Subagent with this Conversation id, when the parent is the user's. */
const ownedSubagent = async (userId: string, id: string) => {
	const [row] = await db
		.select({ parentId: conversation.parentId, number: subagent.number })
		.from(subagent)
		// a Subagent's Conversation is its parent's user's
		.innerJoin(conversation, eq(conversation.id, subagent.conversationId))
		.where(
			and(eq(subagent.conversationId, id), eq(conversation.userId, userId)),
		);
	return row as { parentId: string; number: number } | undefined;
};

export function createConversations({
	config,
	skillFiles,
	orrery = orreryClient,
	store,
	fetch,
	connections,
}: {
	/** Read per call: a Run keeps the config it started with, the next one picks up a reload. */
	config: () => Promise<OrqestraConfig>;
	/** A Skill version's files, read when a User invokes it. */
	skillFiles: (versionId: number) => Promise<SkillFile[]>;
	/** The Sandbox Provider's client, for deleting Sandboxes and copying attachments into them; tests pass a fake. */
	orrery?: typeof orreryClient;
	/** Object storage, where Attachments are kept; tests pass `memoryStore()`. */
	store: ObjectStore;
	/** What MCP requests go through, such as cancelling a Background Call; tests pass a fake server's. */
	fetch?: Fetch;
	/** The Users' Connections, which Background Calls of per-User OAuth MCP Servers are cancelled with. */
	connections?: ConnectionStore;
}) {
	const mcp = { fetch, connections };
	/** The User's text, with the current SKILL.md of the Skill it invokes as `/skill:name` put in, so later versions leave it as sent. */
	async function expandSkill(
		cfg: OrqestraConfig,
		agent: Pick<AgentDefinition, "skills">,
		text: string,
	) {
		const invoked = invokedSkill(text);
		if (!invoked) return text;
		const { name, args } = invoked;
		const skill = turnSkills(cfg, agent).find((s) => s.name === name);
		const md = skill
			? (await skillFiles(skill.versionId)).find((f) => f.path === "SKILL.md")
			: undefined;
		if (!md)
			throw new ConversationError(
				"This Skill is unavailable",
				"text",
				"skill_unavailable",
			);
		return skillBlock(
			name,
			skillInstructions(new TextDecoder().decode(md.content)),
			args,
		);
	}

	/** Deletes the Sandboxes of deleted Conversations; one orrery does not delete is logged and left to its Idle Stop. */
	async function deleteSandboxes(ids: (string | null)[]) {
		const sandboxes = ids.filter((id): id is string => !!id);
		if (!sandboxes.length) return;
		const provider = (await config()).sandboxProvider;
		const client = provider && orrery(provider);
		await Promise.all(
			sandboxes.map((id) =>
				(client
					? client.deleteSandbox(id, { signal: AbortSignal.timeout(10_000) })
					: Promise.reject(new Error("no Sandbox Provider is configured"))
				).catch((error) =>
					console.error(`Sandbox ${id} is left to orrery's Idle Stop`, error),
				),
			),
		);
	}

	return {
		/** Works on queued Runs in this process, each by `handler`, until the returned function is called. */
		serveRuns: (handler: RunHandler, options?: ServeOptions) =>
			serveRuns(config, store, handler, options),

		/** Deletes the Attachments not sent with a message for a day before `now`; the worker does this every hour. */
		sweepUnsentAttachments: (now?: Date) => sweepUnsentAttachments(store, now),

		/** The User's Scheduled Tasks; their Firings run in `serveRuns`. */
		tasks: tasksOf(config),

		/** The browsers that receive the User's Alerts, pushed as their Runs end. */
		alerts,

		/** The online Agents, with the Models and thinking levels each offers; new Conversations only use `pickable` ones. */
		async agentOptions() {
			const cfg = await config();
			// an Agent without Models is offline
			return cfg.agents
				.filter((a) => a.models.length)
				.map((a) => ({
					id: a.id,
					name: a.name,
					description: a.description,
					default: a.default,
					pickable: a.pickable,
					// whether it can tidy the User's Memories, as their Memory page's consolidation task needs
					memory: a.memory,
					defaultModel: a.defaultModel,
					// the User may invoke those the Agent may not
					skills: turnSkills(cfg, a).map(({ name, description }) => ({
						name,
						description,
					})),
					models: a.models.map((ref) => {
						const model = cfg.models.find((m) => modelRef(m) === ref);
						return {
							ref,
							name: model?.name ?? ref,
							thinking: model
								? resolveThinking(a.thinking, model)
								: { allowed: [], default: "off" as ThinkingLevel },
						};
					}),
				}));
		},

		list: (userId: string) =>
			db
				.select({
					id: conversation.id,
					title: conversation.title,
					status: conversation.status,
					incognito: conversation.incognito,
					unread: conversation.unread,
					awaitingReply: conversation.awaitingReply,
					// Subagents queued or at work, which the sidebar marks while the parent itself is idle
					// (spelled out: drizzle leaves the columns of a select's fields unqualified)
					background: sql<boolean>`exists (select 1 from subagent s join conversation child on child.id = s.conversation_id where child.parent_id = conversation.id and s.outcome in ('queued', 'running'))`,
				})
				.from(conversation)
				// a Subagent's Conversation shows only within its parent, a Firing's under its Scheduled Task
				.where(
					and(
						eq(conversation.userId, userId),
						isNull(conversation.parentId),
						isNull(conversation.scheduledTaskId),
					),
				)
				.orderBy(desc(conversation.updatedAt)),

		async get(userId: string, id: string) {
			const conv = await owned(userId, id);
			if (!conv) return undefined;
			const [messages, pending, compactions, subagents, set, calls] =
				await Promise.all([
					db
						.select({
							id: message.id,
							message: message.message,
							model: message.model,
							thinkingLevel: message.thinkingLevel,
							subagentId: message.subagentId,
							backgroundCallId: message.backgroundCallId,
							origin: message.origin,
							queued: sql<boolean>`false`,
						})
						.from(message)
						.where(eq(message.conversationId, id))
						.orderBy(asc(message.id)),
					// inputs the Run has yet to deliver show after what it has
					db
						.select({
							id: inbox.id,
							message: inbox.message,
							model: inbox.model,
							thinkingLevel: inbox.thinkingLevel,
							subagentId: inbox.subagentId,
							backgroundCallId: inbox.backgroundCallId,
							origin: inbox.origin,
							// its id is the inbox's, not a message's
							queued: sql<boolean>`true`,
						})
						.from(inbox)
						.where(eq(inbox.conversationId, id))
						.orderBy(asc(inbox.id)),
					db
						.select({ firstKeptMessageId: compaction.firstKeptMessageId })
						.from(compaction)
						.where(eq(compaction.conversationId, id)),
					// the whole tree's, so its panels drill down to Subagents of Subagents
					db
						.select({
							id: subagent.conversationId,
							parentId: sql<string>`${conversation.parentId}`,
							depth: conversation.depth,
							toolCallId: subagent.toolCallId,
							number: subagent.number,
							template: conversation.agentId,
							brief: subagent.brief,
							outcome: subagent.outcome,
						})
						.from(subagent)
						.innerJoin(
							conversation,
							eq(conversation.id, subagent.conversationId),
						)
						.where(eq(conversation.rootId, id))
						.orderBy(asc(conversation.depth), asc(subagent.number)),
					db.query.timer.findFirst({ where: eq(timer.conversationId, id) }),
					// the whole tree's, each shown at the Tool call that made it
					db
						.select({
							id: backgroundCall.id,
							conversationId: backgroundCall.conversationId,
							toolCallId: backgroundCall.toolCallId,
							mcpServerId: backgroundCall.mcpServerId,
							toolName: backgroundCall.toolName,
							status: backgroundCall.status,
						})
						.from(backgroundCall)
						.innerJoin(
							conversation,
							eq(conversation.id, backgroundCall.conversationId),
						)
						.where(eq(conversation.rootId, id))
						.orderBy(asc(backgroundCall.startedAt)),
				]);
			const cfg = await config();
			return {
				id: conv.id,
				agentId: conv.agentId,
				title: conv.title,
				status: conv.status,
				/** Why the last Run failed, while it stands failed; null otherwise. */
				failure: conv.status === "failed" ? (conv.failure ?? "error") : null,
				incognito: conv.incognito,
				unread: conv.unread,
				awaitingReply: conv.awaitingReply,
				// the Agent was removed from config or has no Model left
				readOnly: !resolveTurn(cfg, conv.agentId),
				messages: [...messages, ...pending].map((m) => ({
					...m,
					message: m.message as Message,
				})),
				compactedBefore: compactions.map((c) => c.firstKeptMessageId),
				subagents,
				/** The Timer set to ring, if any: the Conversation stays idle until it does. */
				timer: set ? { note: set.note, ringsAt: set.ringsAt } : null,
				/** The tree's Background Calls, with the name of their MCP Server (its id once it is gone). */
				backgroundCalls: calls.map((c) => ({
					...c,
					mcpServerName:
						cfg.allMcpServers[c.mcpServerId]?.name ?? c.mcpServerId,
				})),
			};
		},

		/** Starts a Conversation with no messages yet, so attachments can be uploaded before the first one is sent. */
		async start(
			userId: string,
			agentId: string,
			{ incognito = false }: { incognito?: boolean } = {},
		) {
			const cfg = await config();
			const turn = resolveTurn(cfg, agentId);
			if (!turn)
				throw new ConversationError(
					"This Agent is offline",
					"agentId",
					"agent_offline",
				);
			if (!turn.agent.pickable)
				throw new ConversationError(
					"This Agent cannot be picked",
					"agentId",
					"agent_not_pickable",
				);
			const [{ id }] = await db
				.insert(conversation)
				.values({ userId, agentId, incognito })
				.returning({ id: conversation.id });
			return id;
		},

		/**
		 * Streams one attachment into object storage, to go with a message sent later, renamed when the name is taken in the Conversation;
		 * returns its name. Undefined when the Conversation is not the user's.
		 * Throws UploadTooLarge past MAX_UPLOAD_BYTES, and whatever object storage fails with.
		 */
		async upload(
			userId: string,
			id: string,
			name: string,
			body: ReadableStream<Uint8Array>,
			{ signal }: { signal?: AbortSignal } = {},
		) {
			const conv = await owned(userId, id);
			// a Subagent's Conversation is the Agent's to write to, not the User's
			if (!conv || conv.parentId) return undefined;
			if (!resolveTurn(await config(), conv.agentId))
				throw new ConversationError(
					"This Agent is offline",
					"file",
					"agent_offline",
				);
			const stored = await storeAttachment(store, conv, name, body, { signal });
			return { name: stored.name };
		},

		/**
		 * Puts a user message in the inbox (starting a Conversation when there is no id) and has the Agent reply.
		 * Refused once the User's Spending Limit is used up.
		 */
		async send(
			userId: string,
			input: {
				conversationId?: string;
				agentId?: string;
				text: string;
				model?: string;
				thinking?: ThinkingLevel;
				/** Names `upload` returned; with a Sandbox Provider they are copied into the Sandbox before the Agent sees the message. */
				attachments?: string[];
				/** Starts an Incognito Conversation; an existing one keeps what it started as. */
				incognito?: boolean;
			},
		) {
			const names = [...new Set(input.attachments)];
			const notAttachment = new ConversationError(
				"Not an attachment's name",
				"attachments",
				"not_attachment",
			);
			const cfg = await config();
			const existing = input.conversationId
				? await owned(userId, input.conversationId)
				: undefined;
			// the User cannot write to a Subagent: only the Agent that started it can
			if (input.conversationId && (!existing || existing.parentId))
				throw new ConversationError(
					"Conversation not found",
					"conversationId",
					"not_found",
				);
			if ((await spendingLimitStatus(userId))?.reached)
				throw new ConversationError(
					SPENDING_LIMIT_USED_UP,
					"text",
					"spending_limit_reached",
				);
			// the Agent is fixed once a Conversation has messages
			const agentId = existing?.agentId ?? input.agentId ?? cfg.defaultAgent.id;
			const turn = resolveTurn(cfg, agentId, input);
			if (!turn)
				throw new ConversationError(
					"This Agent is offline",
					"agentId",
					"agent_offline",
				);
			// existing Conversations keep their Agent even after it stops being pickable
			if (!existing && !turn.agent.pickable)
				throw new ConversationError(
					"This Agent cannot be picked",
					"agentId",
					"agent_not_pickable",
				);
			const content = await expandSkill(cfg, turn.agent, input.text);
			// marked sent before they are copied, so the sweep cannot delete one on its way into the Sandbox
			const rows =
				existing && names.length
					? await db.transaction(async (tx) => {
							const found = await tx
								.select()
								.from(attachment)
								.where(
									and(
										eq(attachment.conversationId, existing.id),
										inArray(attachment.name, names),
									),
								)
								.for("update");
							// a name never stored, swept, or unsafe (stored names are safe) is refused
							if (found.length !== names.length) throw notAttachment;
							await tx
								.update(attachment)
								.set({ sent: true })
								.where(
									inArray(
										attachment.id,
										found.map((r) => r.id),
									),
								);
							return found;
						})
					: [];
			if (rows.length !== names.length) throw notAttachment;
			const attachments = names.map((name) => ({
				name,
				path: uploadPath(name),
			}));
			const provider = cfg.sandboxProvider;
			if (existing && rows.length && provider) {
				// orrery's 65-second request timeout is too short to copy 50 MB
				const client = orrery({ ...provider, timeoutMs: 10 * 60_000 });
				try {
					const sandbox = await ensureSandbox(existing.id, client, provider);
					await copyAttachments(store, client, sandbox.id, rows);
				} catch (error) {
					// not sent after all: those that were unsent are the sweep's again
					await db
						.update(attachment)
						.set({ sent: false })
						.where(
							inArray(
								attachment.id,
								rows.filter((r) => !r.sent).map((r) => r.id),
							),
						);
					throw error;
				}
			}

			const conversationId = await db.transaction(async (tx) => {
				let id = existing?.id;
				// while a Run goes, it delivers this at its next step boundary; the lock keeps it from going idle past it
				if (id) {
					await lockRoot(tx, id);
					// a User message renews the Agent's Subagent budget and Timer rings (leaving its Timer set), answers its Question, and the User is back: Runs are attended again
					await tx
						.update(conversation)
						.set({
							subagentsSinceUser: 0,
							timerRingsSinceUser: 0,
							awaitingReply: false,
							unattended: false,
						})
						.where(eq(conversation.id, id));
				} else {
					[{ id }] = await tx
						.insert(conversation)
						.values({ userId, agentId, incognito: input.incognito })
						.returning({ id: conversation.id });
				}
				await tx.insert(inbox).values({
					conversationId: id,
					message: attachments.length
						? {
								role: "user",
								content: [
									{ type: "text", text: content },
									{
										type: "text",
										text: provider
											? `\n\nAttached files, in your Sandbox:\n${attachments.map((a) => `- ${a.path}`).join("\n")}`
											: `\n\nAttached files${
													// as the toolbox offers Parse: listed by the Agent and served by a Document Parser
													turn.agent.tools.includes("parse") && cfg.tools.parse
														? ", which the Parse tool reads by name"
														: ""
												}:\n${names.map((name) => `- ${name}`).join("\n")}`,
									},
								],
								// the User sees their names in place of the second text
								attachments,
								timestamp: Date.now(),
							}
						: { role: "user", content, timestamp: Date.now() },
					model: modelRef(turn.model),
					thinkingLevel: turn.thinking,
					wake: true,
				});
				return id;
			});
			await ensureRun(conversationId);
			return conversationId;
		},

		/** Re-runs a failed reply to the last user message, or one that asked a Question, which it withdraws; false when the Conversation is not the user's. */
		async retry(userId: string, id: string) {
			const conv = await owned(userId, id);
			if (!conv) return false;
			if (!resolveTurn(await config(), conv.agentId))
				throw new ConversationError(
					"This Agent is offline",
					"id",
					"agent_offline",
				);
			const dropped = await db.transaction(async (tx) => {
				const claimed = await tx
					.update(conversation)
					.set({ status: "running", jobId: newJobId(), awaitingReply: false })
					.where(
						and(
							eq(conversation.id, id),
							or(
								eq(conversation.status, "failed"),
								and(
									eq(conversation.status, "idle"),
									eq(conversation.awaitingReply, true),
								),
							),
						),
					)
					.returning({ id: conversation.id });
				if (!claimed.length)
					throw new ConversationError(
						"Nothing to retry",
						"id",
						"nothing_to_retry",
					);
				// the Background Calls it made go with it, cancelled once it is gone
				const calls = await runningCalls(
					tx,
					and(
						eq(backgroundCall.conversationId, id),
						sql`${backgroundCall.messageId} > (select max(id) from ${message} where ${message.conversationId} = ${id} and ${message.message}->>'role' = 'user')`,
					),
				);
				// the files it attached go with it; the User's message, with its uploads, stays
				const attached = await tx.execute<{ key: string }>(
					sql`delete from ${attachment} where ${attachment.conversationId} = ${id} and ${attachment.messageId} > (select max(id) from ${message} where ${message.conversationId} = ${id} and ${message.message}->>'role' = 'user') returning ${attachment.key}`,
				);
				// drop the failed reply, if one was saved, with the Subagents it started
				await tx.execute(
					sql`delete from ${message} where ${message.conversationId} = ${id} and ${message.id} > (select max(id) from ${message} where ${message.conversationId} = ${id} and ${message.message}->>'role' = 'user')`,
				);
				// with the Subagents those started in turn, and their Background Calls
				const dropped = sql`with recursive dropped as (
							select id from ${conversation} where ${conversation.parentId} = ${id} and ${conversation.createdAt} >= (select max(created_at) from ${message} where ${message.conversationId} = ${id})
							union all
							select c.id from conversation c join dropped on c.parent_id = dropped.id
						)`;
				const theirs = await runningCalls(
					tx,
					sql`${backgroundCall.conversationId} in (${dropped} select id from dropped)`,
				);
				const subagents = await tx.execute<{
					id: string;
					sandboxId: string | null;
				}>(
					sql`${dropped} delete from ${conversation} where ${conversation.id} in (select id from dropped) returning id, sandbox_id as "sandboxId"`,
				);
				return {
					subagents: subagents.rows,
					keys: attached.rows.map((a) => a.key),
					calls: [...calls, ...theirs],
				};
			});
			// their Runs stop; with their Conversation gone they save nothing more
			await requestStop(dropped.subagents.map((d) => d.id));
			await askToCancel(config, dropped.calls, mcp);
			await deleteSandboxes(dropped.subagents.map((d) => d.sandboxId));
			await deleteObjects(store, [
				...dropped.keys,
				...dropped.subagents.map((d) => `${conv.rootId}/${d.id}/`),
			]);
			await enqueue(id);
			return true;
		},

		/**
		 * Drops this Conversation's Run while it is still queued, or else asks whichever worker runs it to abort it.
		 * Then its Subagents stop too, without waking it: after the Run, so it starts none past this. Its Timer and its Background Calls are cancelled.
		 * False when the Conversation is not the user's.
		 */
		async stop(userId: string, id: string) {
			const conv = await owned(userId, id);
			if (!conv) return false;
			await cancelTimer(id);
			await cancelStoppedCalls(config, id, mcp);
			const job =
				conv.status === "running" && conv.jobId
					? await runQueue(AGENT_RUNS_QUEUE).getJob(conv.jobId)
					: undefined;
			// removing fails when a worker took the job meanwhile; the stop request then reaches it
			const removed =
				!!job &&
				(await job.isWaiting()) &&
				(await job.remove().then(
					() => true,
					() => false,
				));
			if (removed) {
				// the inputs stay in the Conversation, unanswered
				await drain(id);
				// stopped: a Firing's Run that never began ends partial
				await drain(id, "partial");
				await saved(id);
			} else {
				// a worker that took the job but is not yet listening finds the Stop on the row
				if (conv.jobId)
					await db
						.update(conversation)
						.set({ stoppedJobId: conv.jobId })
						.where(eq(conversation.id, id));
				await requestStop([id]);
			}
			// before its Subagents' ends, so none decides it as though the User had stopped only them
			await stopFiring(id);
			await stopSubagents(id, cancelStopped(config, mcp));
			return true;
		},

		/** Before an Admin deletes an MCP Server: its Background Calls are cancelled and end failed. */
		deletingMcpServer: (mcpServerId: string) =>
			endBackgroundCallsOf(config, mcpServerId, mcp),

		/** Cancels the Conversation's Timer at the User's request. False when the Conversation is not the user's. */
		async cancelTimer(userId: string, id: string) {
			if (!(await owned(userId, id))) return false;
			await cancelTimer(id);
			return true;
		},

		/**
		 * Cancels the Background Call of the Tool call `toolCallId` in the user's Conversation or one of its Subagents, at the User's request.
		 * False when the Conversation is not the user's, or the call has ended.
		 */
		async cancelBackgroundCall(userId: string, id: string, toolCallId: string) {
			if (!(await owned(userId, id))) return false;
			return cancelBackgroundCall(config, id, toolCallId, mcp);
		},

		/** The User opened the Conversation: it is no longer Unread. False when it is not the user's. */
		async seen(userId: string, id: string) {
			const seen = await db
				.update(conversation)
				.set({ unread: false })
				.where(and(eq(conversation.id, id), eq(conversation.userId, userId)))
				.returning({ id: conversation.id });
			return seen.length > 0;
		},

		/** False when the Conversation is not the user's. */
		async rename(userId: string, id: string, title: string) {
			const renamed = await db
				.update(conversation)
				.set({ title, titleEdited: true })
				.where(and(eq(conversation.id, id), eq(conversation.userId, userId)))
				.returning({ id: conversation.id });
			return renamed.length > 0;
		},

		/** False when the Conversation is not the user's. */
		async delete(userId: string, id: string) {
			if (!(await owned(userId, id))) return false;
			const tree = await db
				.select({ id: conversation.id })
				.from(conversation)
				.where(eq(conversation.rootId, id));
			// its Run and its Subagents' stop first, then they go; a Run that outlives its Conversation saves nothing more
			await requestStop(tree.map((c) => c.id));
			// their Background Calls go with them, unannounced, and are cancelled once they are gone
			const calls = await runningCalls(
				db,
				inArray(
					backgroundCall.conversationId,
					tree.map((c) => c.id),
				),
			);
			// its Subagents' rows too, so the Sandbox ids are those last stored: a Run claims one under the row's lock
			const deleted = await db
				.delete(conversation)
				.where(eq(conversation.rootId, id))
				.returning({ sandboxId: conversation.sandboxId });
			await askToCancel(config, calls, mcp);
			await deleteSandboxes(deleted.map((d) => d.sandboxId));
			// its Attachments, its Subagents' too, are kept under its id
			if (deleted.length) await deleteObjects(store, [`${id}/`]);
			return true;
		},

		/**
		 * An Attachment of the user's Conversation, a Subagent's included, by name, streamed from object storage:
		 * a User's upload, or a file the Agent attached as it was then, whatever its Sandbox holds now.
		 */
		async openFile(
			userId: string,
			id: string,
			name: string,
		): Promise<
			| {
					file: {
						name: string;
						size: number;
						body: ReadableStream<Uint8Array>;
					};
			  }
			| { error: "not_found" }
		> {
			// a Subagent's Conversation carries its parent's userId
			if (!(await owned(userId, id))) return { error: "not_found" };
			const [row] = await db
				.select({ key: attachment.key })
				.from(attachment)
				.where(
					and(eq(attachment.conversationId, id), eq(attachment.name, name)),
				);
			const object = row && (await store.get(row.key));
			return object ? { file: { name, ...object } } : { error: "not_found" };
		},

		/**
		 * Reverses the Memory change of the Agent's Tool call `toolCallId` in the user's Conversation (`undoChange`),
		 * and marks that call's result `undone`. Refuses when the Memory changed since, so a later change is never lost.
		 */
		async undoMemory(
			userId: string,
			id: string,
			toolCallId: string,
		): Promise<{ error?: Undone }> {
			if (!(await owned(userId, id))) return { error: "not_found" };
			const error = await undoChange(userId, id, toolCallId, (tx) =>
				tx
					.update(message)
					.set({
						message: sql`jsonb_set(${message.message}, '{details,undone}', 'true')`,
					})
					.where(
						and(
							eq(message.conversationId, id),
							sql`${message.message} @> ${JSON.stringify({ role: "toolResult", toolCallId })}::jsonb`,
						),
					),
			);
			if (error) return { error };
			await saved(id);
			return {};
		},

		/**
		 * A Subagent's transcript, loaded when its panel opens, each message with the Subagent or Background Call
		 * whose Notification it is; undefined when it is not the user's.
		 */
		async subagentTranscript(userId: string, id: string) {
			if (!(await ownedSubagent(userId, id))) return undefined;
			const rows = await db
				.select({
					message: message.message,
					subagentId: message.subagentId,
					backgroundCallId: message.backgroundCallId,
				})
				.from(message)
				.where(eq(message.conversationId, id))
				.orderBy(asc(message.id));
			return rows.map((r) => ({ ...r, message: r.message as Message }));
		},

		/** Stops one Subagent at the User's request; like the Agent's subagent_stop, it does not wake the parent. False when it is not the user's. */
		async stopSubagent(userId: string, id: string) {
			const row = await ownedSubagent(userId, id);
			if (!row) return false;
			await stopSubagents(row.parentId, cancelStopped(config, mcp), [
				row.number,
			]);
			return true;
		},

		/**
		 * A Conversation's ConversationEvents as server-sent events, relayed from Postgres NOTIFY.
		 * Clients load saved messages first and then follow this stream; a reply is stored only once it ends (finished or stopped).
		 * Undefined when the Conversation is not the user's.
		 */
		async subscribe(userId: string, id: string, signal: AbortSignal) {
			if (!(await owned(userId, id))) return undefined;
			// shortcut: one Postgres connection per open stream; move to a shared LISTEN connection if streams pile up
			const client = new pg.Client({
				connectionString: process.env.DATABASE_URL,
			});
			await client.connect();
			// the id is a uuid read back from the database, safe to quote as an identifier
			await client.query(`LISTEN "${conversationChannel(id)}"`);
			const encoder = new TextEncoder();
			let ping: ReturnType<typeof setInterval>;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					const close = () => {
						clearInterval(ping);
						// NOTIFYs still arrive until the connection has ended
						client.removeAllListeners("notification");
						void client.end();
						try {
							controller.close();
						} catch {} // already closed
					};
					client.on("notification", (n) =>
						controller.enqueue(encoder.encode(`data: ${n.payload}\n\n`)),
					);
					client.on("error", close);
					signal.addEventListener("abort", close);
					// the client may have gone while the connection was opening
					if (signal.aborted) return close();
					// keeps proxies from closing an idle stream
					ping = setInterval(
						() => controller.enqueue(encoder.encode(": ping\n\n")),
						15_000,
					);
				},
				cancel() {
					clearInterval(ping);
					client.removeAllListeners("notification");
					void client.end();
				},
			});
		},
	};
}

export type Conversations = ReturnType<typeof createConversations>;
