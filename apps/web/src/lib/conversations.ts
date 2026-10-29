import type { Message } from "@earendil-works/pi-ai";
import {
	modelRef,
	resolveThinking,
	resolveTurn,
	type ThinkingLevel,
} from "@orqestra/config";
import {
	AGENT_RUNS_QUEUE,
	conversationChannel,
	db,
	STOP_CHANNEL,
} from "@orqestra/db";
import { compaction, conversation, message } from "@orqestra/db/schema";
import { createPostgresBackend, Queue } from "bullmq";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import pg from "pg";
import { config } from "#/lib/config";

// Server-only Conversation logic, keyed by the signed-in user's id; server functions wrap it in conversation-fns.ts.
// Every query is scoped to that user: nobody else, Admins included, can see a Conversation.

const newQueue = () =>
	new Queue(
		AGENT_RUNS_QUEUE,
		{ connection: { connectionString: process.env.DATABASE_URL as string } },
		createPostgresBackend,
	);
let queue: ReturnType<typeof newQueue> | undefined;

async function enqueue(conversationId: string) {
	queue ??= newQueue();
	try {
		await queue.add(
			"run",
			{ conversationId },
			{ removeOnComplete: true, removeOnFail: 1000 },
		);
	} catch (error) {
		await db
			.update(conversation)
			.set({ status: "failed" })
			.where(eq(conversation.id, conversationId));
		throw error;
	}
}

const owned = (userId: string, id: string) =>
	db.query.conversation.findFirst({
		where: and(eq(conversation.id, id), eq(conversation.userId, userId)),
	});

/** The Agents a new Conversation can use, with the Models and thinking levels each offers. */
export async function listAgentOptions() {
	const cfg = await config;
	return cfg.agents.map((a) => ({
		id: a.id,
		name: a.name,
		description: a.description,
		default: a.default,
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
		})
		.from(conversation)
		.where(eq(conversation.userId, userId))
		.orderBy(desc(conversation.updatedAt));

export async function getConversation(userId: string, id: string) {
	const conv = await owned(userId, id);
	if (!conv) return undefined;
	const [messages, compactions] = await Promise.all([
		db
			.select({
				id: message.id,
				message: message.message,
				model: message.model,
				thinkingLevel: message.thinkingLevel,
			})
			.from(message)
			.where(eq(message.conversationId, id))
			.orderBy(asc(message.id)),
		db
			.select({ firstKeptMessageId: compaction.firstKeptMessageId })
			.from(compaction)
			.where(eq(compaction.conversationId, id)),
	]);
	return {
		id: conv.id,
		agentId: conv.agentId,
		title: conv.title,
		status: conv.status,
		// the Agent was removed from config
		readOnly: !resolveTurn(await config, conv.agentId),
		messages: messages.map((m) => ({
			...m,
			message: m.message as Message,
		})),
		compactedBefore: compactions.map((c) => c.firstKeptMessageId),
	};
}

export class ConversationError extends Error {
	override name = "ConversationError";
}

/** Saves a user message (starting a Conversation when there is no id) and queues the Agent's reply. */
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
	const cfg = await config;
	const existing = input.conversationId
		? await owned(userId, input.conversationId)
		: undefined;
	if (input.conversationId && !existing)
		throw new ConversationError("Conversation not found");
	// the Agent is fixed once a Conversation has messages
	const agentId = existing?.agentId ?? input.agentId ?? cfg.defaultAgent.id;
	const turn = resolveTurn(cfg, agentId, input);
	if (!turn) throw new ConversationError("This Agent is offline");

	const conversationId = await db.transaction(async (tx) => {
		let id = existing?.id;
		if (id) {
			// one run at a time per Conversation
			const claimed = await tx
				.update(conversation)
				.set({ status: "running" })
				.where(and(eq(conversation.id, id), ne(conversation.status, "running")))
				.returning({ id: conversation.id });
			if (!claimed.length)
				throw new ConversationError("A reply is still being generated");
		} else {
			[{ id }] = await tx
				.insert(conversation)
				.values({ userId, agentId, status: "running" })
				.returning({ id: conversation.id });
		}
		await tx.insert(message).values({
			conversationId: id,
			message: { role: "user", content: input.text, timestamp: Date.now() },
			model: modelRef(turn.model),
			thinkingLevel: turn.thinking,
		});
		return id;
	});
	await enqueue(conversationId);
	return conversationId;
}

/** Re-runs a failed reply to the last user message. */
export async function retryRun(userId: string, id: string) {
	const conv = await owned(userId, id);
	if (!conv) return;
	if (!resolveTurn(await config, conv.agentId))
		throw new ConversationError("This Agent is offline");
	await db.transaction(async (tx) => {
		const claimed = await tx
			.update(conversation)
			.set({ status: "running" })
			.where(and(eq(conversation.id, id), eq(conversation.status, "failed")))
			.returning({ id: conversation.id });
		if (!claimed.length) throw new ConversationError("Nothing to retry");
		// drop the failed reply, if one was saved
		await tx.execute(
			sql`delete from ${message} where ${message.conversationId} = ${id} and ${message.id} > (select max(id) from ${message} where ${message.conversationId} = ${id} and ${message.message}->>'role' = 'user')`,
		);
	});
	await enqueue(id);
}

/** Asks whichever worker runs this Conversation to abort it. */
export async function stopRun(userId: string, id: string) {
	if (!(await owned(userId, id))) return;
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
	await db
		.delete(conversation)
		.where(and(eq(conversation.id, id), eq(conversation.userId, userId)));
}

/**
 * Server-sent events of a Conversation's ConversationEvents, relayed from Postgres NOTIFY.
 * Clients load saved messages first and then follow this stream; partial replies are never stored.
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
