import type { Message } from "@earendil-works/pi-ai";
import {
	modelRef,
	type OrqestraConfig,
	resolveTurn,
	type ThinkingLevel,
} from "@orqestra/config";
import { db } from "@orqestra/db";
import {
	compaction,
	conversation,
	inbox,
	message,
	subagent,
} from "@orqestra/db/schema";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import pg from "pg";
import {
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

import { type RunHandle, type ServeOptions, serveRuns } from "./serve.ts";

export type { ConversationEvent } from "./runs.ts";
export { MAX_SUBAGENTS } from "./runs.ts";
export {
	BudgetExceeded,
	MAX_SUBAGENT_TASKS,
	MAX_SUBAGENTS_PER_USER_MESSAGE,
	NoSuchSubagent,
	NoSuchTemplate,
	type Outcome,
	type RunHandle,
	type StreamEvent,
	TemplateOffline,
	type Transcript,
	type TranscriptMessage,
	type Turn,
} from "./serve.ts";

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
}: {
	/** Read per call: a Run keeps the config it started with, the next one picks up a reload. */
	config: () => Promise<OrqestraConfig>;
}) {
	return {
		/** Works on queued Runs in this process, each by `handler`, until the returned function is called. */
		serveRuns: (
			handler: (run: RunHandle) => Promise<void>,
			options?: ServeOptions,
		) => serveRuns(config, handler, options),

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

		/** Puts a user message in the inbox (starting a Conversation when there is no id) and has the Agent reply. */
		async send(
			userId: string,
			input: {
				conversationId?: string;
				agentId?: string;
				text: string;
				model?: string;
				thinking?: ThinkingLevel;
			},
		) {
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
					message: { role: "user", content: input.text, timestamp: Date.now() },
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
					await tx.execute<{ id: string }>(
						sql`delete from ${conversation} where ${conversation.parentId} = ${id} and ${conversation.createdAt} >= (select max(created_at) from ${message} where ${message.conversationId} = ${id}) returning id`,
					)
				).rows;
			});
			// their Runs stop; with their Conversation gone they save nothing more
			await requestStop(dropped.map((d) => d.id));
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
					? await runQueue().getJob(conv.jobId)
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
			// its Run and its Subagents' stop first, then they go (cascade); a Run that outlives its Conversation saves nothing more
			await requestStop([id, ...children.map((c) => c.id)]);
			await db.delete(conversation).where(eq(conversation.id, id));
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
