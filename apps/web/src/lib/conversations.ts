import type { Message } from "@earendil-works/pi-ai";
import {
	modelRef,
	resolveThinking,
	resolveTurn,
	type ThinkingLevel,
} from "@orqestra/config";
import {
	type ConversationEvent,
	conversationChannel,
	db,
	lockRoot,
	STOP_CHANNEL,
} from "@orqestra/db";
import {
	drain,
	enqueue,
	ensureRun,
	runQueue,
	stopSubagents,
} from "@orqestra/db/runs";
import {
	compaction,
	conversation,
	inbox,
	message,
	subagent,
} from "@orqestra/db/schema";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import pg from "pg";
import { config } from "#/lib/config";

// Server-only Conversation logic, keyed by the signed-in user's id; server functions wrap it in conversation-fns.ts.
// Every query is scoped to that user: nobody else, Admins included, can see a Conversation.

const owned = (userId: string, id: string) =>
	db.query.conversation.findFirst({
		where: and(eq(conversation.id, id), eq(conversation.userId, userId)),
	});

/** The online Agents, with the Models and thinking levels each offers; new Conversations only use `pickable` ones. */
export async function listAgentOptions() {
	const cfg = await config.get();
	// an Agent without Models is offline
	return cfg.agents
		.filter((a) => a.models.length)
		.map((a) => ({
			id: a.id,
			name: a.name,
			description: a.description,
			default: a.default,
			pickable: a.pickable,
			defaultModel: a.defaultModel,
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
}

export const listConversations = (userId: string) =>
	db
		.select({
			id: conversation.id,
			title: conversation.title,
			status: conversation.status,
			// Subagents still at work after the parent went idle
			background: sql<boolean>`exists (select 1 from ${subagent} where ${subagent.parentId} = ${conversation.id} and ${subagent.outcome} in ('queued', 'running'))`,
		})
		.from(conversation)
		// a Subagent's Conversation shows only within its parent
		.where(and(eq(conversation.userId, userId), isNull(conversation.parentId)))
		.orderBy(desc(conversation.updatedAt));

export async function getConversation(userId: string, id: string) {
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
			})
			.from(message)
			.where(eq(message.conversationId, id))
			.orderBy(asc(message.id)),
		// inputs the Run has yet to deliver show after what it has
		db
			.select({
				id: sql<number>`-${inbox.id}`,
				message: inbox.message,
				model: inbox.model,
				thinkingLevel: inbox.thinkingLevel,
				subagentId: inbox.subagentId,
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
				template: subagent.template,
				brief: subagent.brief,
				status: subagent.outcome,
			})
			.from(subagent)
			.where(eq(subagent.parentId, id))
			.orderBy(asc(subagent.number)),
	]);
	return {
		id: conv.id,
		agentId: conv.agentId,
		title: conv.title,
		status: conv.status,
		// the Agent was removed from config or has no Model left
		readOnly: !resolveTurn(await config.get(), conv.agentId),
		messages: [...messages, ...pending].map((m) => ({
			...m,
			message: m.message as Message,
		})),
		compactedBefore: compactions.map((c) => c.firstKeptMessageId),
		subagents,
	};
}

/** The parent's Subagent with this Conversation id, when the parent is the user's. */
const ownedSubagent = async (userId: string, id: string) => {
	const [row] = await db
		.select({ parentId: subagent.parentId, number: subagent.number })
		.from(subagent)
		.innerJoin(conversation, eq(conversation.id, subagent.parentId))
		.where(
			and(eq(subagent.conversationId, id), eq(conversation.userId, userId)),
		);
	return row;
};

/** A Subagent's transcript, loaded when its panel opens; undefined when it is not the user's. */
export async function getSubagentMessages(userId: string, id: string) {
	if (!(await ownedSubagent(userId, id))) return undefined;
	const rows = await db
		.select({ message: message.message })
		.from(message)
		.where(eq(message.conversationId, id))
		.orderBy(asc(message.id));
	return rows.map((r) => r.message as Message);
}

/** Stops one Subagent at the User's request; like the Agent's subagent_stop, it does not wake the parent. */
export async function stopSubagent(userId: string, id: string) {
	const row = await ownedSubagent(userId, id);
	if (row) await stopSubagents(row.parentId, [row.number]);
}

export class ConversationError extends Error {
	override name = "ConversationError";
}

export { ensureRun };

/** Puts a user message in the inbox (starting a Conversation when there is no id) and has the Agent reply. */
export async function sendMessage(
	userId: string,
	input: {
		conversationId?: string;
		agentId?: string;
		text: string;
		model?: string;
		thinking?: ThinkingLevel;
	},
) {
	const cfg = await config.get();
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
		if (id) await lockRoot(tx, id);
		else {
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
}

/** Re-runs a failed reply to the last user message. */
export async function retryRun(userId: string, id: string) {
	const conv = await owned(userId, id);
	if (!conv) return;
	if (!resolveTurn(await config.get(), conv.agentId))
		throw new ConversationError("This Agent is offline");
	const dropped = await db.transaction(async (tx) => {
		const claimed = await tx
			.update(conversation)
			.set({ status: "running" })
			.where(and(eq(conversation.id, id), eq(conversation.status, "failed")))
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
	await stopAll(dropped.map((d) => d.id));
	await enqueue(id);
}

const stopAll = (ids: string[]) =>
	Promise.all(
		ids.map((id) => db.execute(sql`select pg_notify(${STOP_CHANNEL}, ${id})`)),
	);

/**
 * Drops this Conversation's run while it is still queued, or else asks whichever worker runs it to abort it.
 * Its Subagents stop too, without waking it.
 */
export async function stopRun(userId: string, id: string) {
	if (!(await owned(userId, id))) return;
	await stopSubagents(id);
	// shortcut: scans every waiting job, fine while the queue stays short; key jobs by Conversation if it grows
	for (const job of await runQueue().getWaiting()) {
		if (job.data.conversationId !== id) continue;
		// fails when a worker took the job meanwhile; the NOTIFY below then reaches it
		const removed = await job.remove().then(
			() => true,
			() => false,
		);
		if (!removed) break;
		// the inputs stay in the Conversation, unanswered
		await drain(id);
		await drain(id, true);
		const saved: ConversationEvent = { type: "saved" };
		await db.execute(
			sql`select pg_notify(${conversationChannel(id)}, ${JSON.stringify(saved)})`,
		);
		return;
	}
	await db.execute(sql`select pg_notify(${STOP_CHANNEL}, ${id})`);
}

export async function renameConversation(
	userId: string,
	id: string,
	title: string,
) {
	await db
		.update(conversation)
		.set({ title, titleEdited: true })
		.where(and(eq(conversation.id, id), eq(conversation.userId, userId)));
}

export async function deleteConversation(userId: string, id: string) {
	if (!(await owned(userId, id))) return;
	const children = await db
		.select({ id: conversation.id })
		.from(conversation)
		.where(eq(conversation.parentId, id));
	await db.delete(conversation).where(eq(conversation.id, id));
	// its Subagents went with it (cascade); their Runs stop
	await stopAll(children.map((c) => c.id));
}

/**
 * Server-sent events of a Conversation's ConversationEvents, relayed from Postgres NOTIFY.
 * Clients load saved messages first and then follow this stream; a reply is stored only once it ends (finished or stopped).
 * Undefined when the Conversation is not the user's.
 */
export async function conversationEvents(
	userId: string,
	id: string,
	signal: AbortSignal,
) {
	if (!(await owned(userId, id))) return undefined;
	// shortcut: one Postgres connection per open stream; move to a shared LISTEN connection if streams pile up
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	// the id is a uuid read back from the database, safe to quote as an identifier
	await client.query(`LISTEN "${conversationChannel(id)}"`);
	const encoder = new TextEncoder();
	let ping: ReturnType<typeof setInterval>;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const close = () => {
				clearInterval(ping);
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
			void client.end();
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		},
	});
}
