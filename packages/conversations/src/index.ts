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
	compaction,
	conversation,
	inbox,
	message,
	subagent,
} from "@orqestra/db/schema";
import {
	OrreryError,
	orrery as orreryClient,
	workspacePath,
} from "@orqestra/tools";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import pg from "pg";
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
	stopSubagents,
} from "./runs.ts";

import { ensureSandbox, SandboxGone, wakeSandbox } from "./sandbox.ts";
import { type RunHandler, type ServeOptions, serveRuns } from "./serve.ts";
import { safeFileName, uploadPath, writeUpload } from "./uploads.ts";

export { MAX_UPLOAD_BYTES } from "@orqestra/config";
export {
	MAX_MEMORIES,
	MAX_MEMORY_BODY,
	MAX_MEMORY_DESCRIPTION,
	type Memories,
	type Memory,
	MemoryError,
} from "./memories.ts";
export {
	MAX_RECALL_RESULTS,
	MAX_SNIPPET,
	type Recall,
	type Recalled,
} from "./recall.ts";
export type { ConversationEvent, Ended } from "./runs.ts";
export { MAX_SUBAGENTS } from "./runs.ts";
export { ensureSandbox } from "./sandbox.ts";
export {
	BudgetExceeded,
	MAX_SUBAGENT_TASKS,
	MAX_SUBAGENTS_PER_USER_MESSAGE,
	NoSuchSubagent,
	NoSuchTemplate,
	type RunHandle,
	type RunHandler,
	type StreamEvent,
	TemplateOffline,
	type Transcript,
	type TranscriptMessage,
	type Turn,
} from "./serve.ts";
export { UploadTooLarge } from "./uploads.ts";

// The only module that reads and writes Conversations, their Inbox, messages, Subagents and compactions.
// The User's side takes the signed-in user's id everywhere: nobody else, Admins included, can see a Conversation.

export class ConversationError extends Error {
	override name = "ConversationError";
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
}: {
	/** Read per call: a Run keeps the config it started with, the next one picks up a reload. */
	config: () => Promise<OrqestraConfig>;
	/** A Skill version's files, read when a User invokes it. */
	skillFiles: (versionId: number) => Promise<SkillFile[]>;
	/** The Sandbox Provider's client, for deleting Sandboxes and uploading attachments; tests pass a fake. */
	orrery?: typeof orreryClient;
}) {
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
		if (!md) throw new ConversationError("This Skill is unavailable");
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
			serveRuns(config, handler, options),

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
					attachments: !!cfg.sandboxProvider,
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
					// Subagents queued or at work, which the sidebar marks while the parent itself is idle
					// (spelled out: drizzle leaves the columns of a select's fields unqualified)
					background: sql<boolean>`exists (select 1 from subagent s join conversation child on child.id = s.conversation_id where child.parent_id = conversation.id and s.outcome in ('queued', 'running'))`,
				})
				.from(conversation)
				// a Subagent's Conversation shows only within its parent
				.where(
					and(eq(conversation.userId, userId), isNull(conversation.parentId)),
				)
				.orderBy(desc(conversation.updatedAt)),

		async get(userId: string, id: string) {
			const conv = await owned(userId, id);
			if (!conv) return undefined;
			const [messages, pending, compactions, subagents] = await Promise.all([
				db
					.select({
						id: message.id,
						message: message.message,
						model: message.model,
						thinkingLevel: message.thinkingLevel,
						subagentId: message.subagentId,
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
				db
					.select({
						id: subagent.conversationId,
						toolCallId: subagent.toolCallId,
						number: subagent.number,
						template: conversation.agentId,
						brief: subagent.brief,
						outcome: subagent.outcome,
					})
					.from(subagent)
					.innerJoin(conversation, eq(conversation.id, subagent.conversationId))
					.where(eq(conversation.parentId, id))
					.orderBy(asc(subagent.number)),
			]);
			return {
				id: conv.id,
				agentId: conv.agentId,
				title: conv.title,
				status: conv.status,
				// the Agent was removed from config or has no Model left
				readOnly: !resolveTurn(await config(), conv.agentId),
				messages: [...messages, ...pending].map((m) => ({
					...m,
					message: m.message as Message,
				})),
				compactedBefore: compactions.map((c) => c.firstKeptMessageId),
				subagents,
			};
		},

		/** Starts a Conversation with no messages yet, so attachments can be uploaded before the first one is sent. */
		async start(userId: string, agentId: string) {
			const cfg = await config();
			const turn = resolveTurn(cfg, agentId);
			if (!turn) throw new ConversationError("This Agent is offline");
			if (!turn.agent.pickable)
				throw new ConversationError("This Agent cannot be picked");
			const [{ id }] = await db
				.insert(conversation)
				.values({ userId, agentId })
				.returning({ id: conversation.id });
			return id;
		},

		/**
		 * Streams one attachment into the Conversation's Sandbox (creating or waking it) as `/workspace/uploads/<name>`,
		 * renamed when the name is taken; returns its name and path. Undefined when the Conversation is not the user's.
		 * Throws UploadTooLarge past MAX_UPLOAD_BYTES, and whatever the Sandbox Provider fails with.
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
			const cfg = await config();
			const turn = resolveTurn(cfg, conv.agentId);
			if (!turn || !cfg.sandboxProvider)
				throw new ConversationError("This Agent takes no attachments");
			// orrery's 65-second request timeout is too short to stream 50 MB from a slow browser
			const client = orrery({ ...cfg.sandboxProvider, timeoutMs: 10 * 60_000 });
			const sandbox = await ensureSandbox(id, client, cfg.sandboxProvider, {
				signal,
			});
			return writeUpload(client, sandbox.id, name, body, { signal });
		},

		/** Puts a user message in the inbox (starting a Conversation when there is no id) and has the Agent reply. */
		async send(
			userId: string,
			input: {
				conversationId?: string;
				agentId?: string;
				text: string;
				model?: string;
				thinking?: ThinkingLevel;
				/** Names `upload` returned; the message gives the Agent their paths. */
				attachments?: string[];
			},
		) {
			const attachments = (input.attachments ?? []).map((name) => {
				if (safeFileName(name) !== name)
					throw new ConversationError("Not an attachment's name");
				return { name, path: uploadPath(name) };
			});
			const cfg = await config();
			const existing = input.conversationId
				? await owned(userId, input.conversationId)
				: undefined;
			// the User cannot write to a Subagent: only the Agent that started it can
			if (input.conversationId && (!existing || existing.parentId))
				throw new ConversationError("Conversation not found");
			// the Agent is fixed once a Conversation has messages
			const agentId = existing?.agentId ?? input.agentId ?? cfg.defaultAgent.id;
			const turn = resolveTurn(cfg, agentId, input);
			if (!turn) throw new ConversationError("This Agent is offline");
			// existing Conversations keep their Agent even after it stops being pickable
			if (!existing && !turn.agent.pickable)
				throw new ConversationError("This Agent cannot be picked");
			const content = await expandSkill(cfg, turn.agent, input.text);

			const conversationId = await db.transaction(async (tx) => {
				let id = existing?.id;
				// while a Run goes, it delivers this at its next step boundary; the lock keeps it from going idle past it
				if (id) {
					await lockRoot(tx, id);
					// a User message renews the Agent's Subagent budget
					await tx
						.update(conversation)
						.set({ subagentsSinceUser: 0 })
						.where(eq(conversation.id, id));
				} else {
					[{ id }] = await tx
						.insert(conversation)
						.values({ userId, agentId })
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
										text: `\n\nAttached files, in your Sandbox:\n${attachments.map((a) => `- ${a.path}`).join("\n")}`,
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

		/** Re-runs a failed reply to the last user message. */
		async retry(userId: string, id: string) {
			const conv = await owned(userId, id);
			if (!conv) return;
			if (!resolveTurn(await config(), conv.agentId))
				throw new ConversationError("This Agent is offline");
			const dropped = await db.transaction(async (tx) => {
				const claimed = await tx
					.update(conversation)
					.set({ status: "running", jobId: newJobId() })
					.where(
						and(eq(conversation.id, id), eq(conversation.status, "failed")),
					)
					.returning({ id: conversation.id });
				if (!claimed.length) throw new ConversationError("Nothing to retry");
				// drop the failed reply, if one was saved, with the Subagents it started
				await tx.execute(
					sql`delete from ${message} where ${message.conversationId} = ${id} and ${message.id} > (select max(id) from ${message} where ${message.conversationId} = ${id} and ${message.message}->>'role' = 'user')`,
				);
				return (
					await tx.execute<{ id: string; sandboxId: string | null }>(
						sql`delete from ${conversation} where ${conversation.parentId} = ${id} and ${conversation.createdAt} >= (select max(created_at) from ${message} where ${message.conversationId} = ${id}) returning id, sandbox_id as "sandboxId"`,
					)
				).rows;
			});
			// their Runs stop; with their Conversation gone they save nothing more
			await requestStop(dropped.map((d) => d.id));
			await deleteSandboxes(dropped.map((d) => d.sandboxId));
			await enqueue(id);
		},

		/**
		 * Drops this Conversation's Run while it is still queued, or else asks whichever worker runs it to abort it.
		 * Then its Subagents stop too, without waking it: after the Run, so it starts none past this.
		 */
		async stop(userId: string, id: string) {
			const conv = await owned(userId, id);
			if (!conv) return;
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
				await drain(id, true);
				await saved(id);
			} else await requestStop([id]);
			await stopSubagents(id);
		},

		async rename(userId: string, id: string, title: string) {
			await db
				.update(conversation)
				.set({ title, titleEdited: true })
				.where(and(eq(conversation.id, id), eq(conversation.userId, userId)));
		},

		async delete(userId: string, id: string) {
			if (!(await owned(userId, id))) return;
			const children = await db
				.select({ id: conversation.id })
				.from(conversation)
				.where(eq(conversation.parentId, id));
			// its Run and its Subagents' stop first, then they go; a Run that outlives its Conversation saves nothing more
			await requestStop([id, ...children.map((c) => c.id)]);
			// its Subagents' rows too, so the Sandbox ids are those last stored: a Run claims one under the row's lock
			const deleted = await db
				.delete(conversation)
				.where(or(eq(conversation.id, id), eq(conversation.parentId, id)))
				.returning({ sandboxId: conversation.sandboxId });
			await deleteSandboxes(deleted.map((d) => d.sandboxId));
		},

		/**
		 * A file the Agent attached in the user's Conversation, a Subagent's included, streamed from its Sandbox by orrery as it arrives.
		 * Starts the Sandbox if Idle Stop stopped it, but never creates one. `path` is absolute or relative to /workspace.
		 */
		async openFile(
			userId: string,
			id: string,
			path: string,
			signal: AbortSignal,
		): Promise<
			| {
					file: {
						name: string;
						size?: number;
						body: ReadableStream<Uint8Array>;
					};
			  }
			| { error: "not_found" | "no_file" | "gone" | "unavailable" }
		> {
			// a Subagent's Conversation carries its parent's userId
			if (!(await owned(userId, id))) return { error: "not_found" };
			const relative = workspacePath(path);
			if (!relative) return { error: "no_file" };
			// only what the Agent attached here: the rest of the Sandbox is its working space
			const attached = await db
				.select({ id: message.id })
				.from(message)
				.where(
					and(
						eq(message.conversationId, id),
						sql`${message.message} @> ${JSON.stringify({
							role: "toolResult",
							toolName: "attach",
							details: { attachment: { path: `/workspace/${relative}` } },
						})}::jsonb`,
					),
				)
				.limit(1);
			if (!attached.length) return { error: "no_file" };
			const provider = (await config()).sandboxProvider;
			if (!provider) return { error: "unavailable" };
			const client = orrery(provider);
			try {
				const { id: sandbox } = await wakeSandbox(id, client, provider, {
					signal,
				});
				const file = await client.openFile(sandbox, relative, { signal });
				return {
					file: {
						name: relative.slice(relative.lastIndexOf("/") + 1),
						...file,
					},
				};
			} catch (error) {
				if (error instanceof SandboxGone) return { error: "gone" };
				if (error instanceof OrreryError && error.code === "not_found")
					return { error: "no_file" };
				if (!signal.aborted)
					console.error("A file could not be read from its Sandbox:", error);
				return { error: "unavailable" };
			}
		},

		/** A Subagent's transcript, loaded when its panel opens; undefined when it is not the user's. */
		async subagentTranscript(userId: string, id: string) {
			if (!(await ownedSubagent(userId, id))) return undefined;
			const rows = await db
				.select({ message: message.message })
				.from(message)
				.where(eq(message.conversationId, id))
				.orderBy(asc(message.id));
			return rows.map((r) => r.message as Message);
		},

		/** Stops one Subagent at the User's request; like the Agent's subagent_stop, it does not wake the parent. */
		async stopSubagent(userId: string, id: string) {
			const row = await ownedSubagent(userId, id);
			if (row) await stopSubagents(row.parentId, [row.number]);
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
