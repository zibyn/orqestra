import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export const db = drizzle(process.env.DATABASE_URL!, { schema });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Locks the row of a Conversation's root (a Subagent's parent, else itself): every Run start and finish decides under it. */
export const lockRoot = (tx: Tx, conversationId: string) =>
	tx.execute(
		sql`select 1 from ${schema.conversation} where ${schema.conversation.id} = (select coalesce(${schema.conversation.parentId}, ${schema.conversation.id}) from ${schema.conversation} where ${schema.conversation.id} = ${conversationId}) for update`,
	);

/**
 * Delivers a Conversation's inbox into `message`, in arrival order, under its root's lock; returns what it delivered.
 * With `finish`, an empty inbox sets the Conversation idle instead: checked under the same lock a sender starts a Run under, so no input is left behind.
 */
export async function drain(conversationId: string, finish = false) {
	return db.transaction(async (tx) => {
		await lockRoot(tx, conversationId);
		const inputs = (
			await tx
				.delete(schema.inbox)
				.where(eq(schema.inbox.conversationId, conversationId))
				.returning()
		).sort((a, b) => a.id - b.id);
		if (inputs.length)
			await tx.insert(schema.message).values(
				inputs.map((i) => ({
					conversationId,
					message: i.message,
					model: i.model,
					thinkingLevel: i.thinkingLevel,
					subagentId: i.subagentId,
				})),
			);
		else if (finish)
			await tx
				.update(schema.conversation)
				.set({ status: "idle" })
				.where(eq(schema.conversation.id, conversationId));
		// pi UserMessages
		return inputs.map((i) => i.message);
	});
}

/** Subagents of one parent Conversation running at once; more wait their turn. */
export const MAX_SUBAGENTS = 4;

// so apps (the worker) can query without their own drizzle-orm dependency
export { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

/** BullMQ queue with one job `{ conversationId }` per message to reply to. */
export const AGENT_RUNS_QUEUE = "agent-runs";

/** NOTIFY channel carrying a Conversation's ConversationEvents (worker -> web SSE). */
export const conversationChannel = (conversationId: string) =>
	`conversation_${conversationId}`;

/** NOTIFY channel whose payload is the id of the Conversation whose run should stop (web -> worker). */
export const STOP_CHANNEL = "conversation_stop";

/** NOTIFY channel, no payload: Providers or enabled Models changed, reload the config (web -> web and worker). */
export const CONFIG_CHANNEL = "config_changed";

// `subagent` is the subagent row id when the streaming reply is a Subagent's; without it, the Conversation's own
export type ConversationEvent =
	| { type: "start"; subagent?: string } // an Agent reply began streaming
	| {
			type: "delta";
			kind: "text" | "thinking";
			index: number;
			delta: string;
			subagent?: string;
	  }
	| { type: "end"; subagent?: string } // that reply finished, saved or failed: reload, then drop its live copy
	| { type: "saved" }; // messages, title, status or compaction changed in the db: reload them
