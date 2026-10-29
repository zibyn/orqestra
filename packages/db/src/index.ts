import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

export const db = drizzle(process.env.DATABASE_URL!, { schema });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Locks the row of a Conversation's root (a Subagent's parent, else itself): every Run start and finish decides under it. */
export const lockRoot = (tx: Tx, conversationId: string) =>
	tx.execute(
		sql`select 1 from ${schema.conversation} where ${schema.conversation.id} = (select coalesce(${schema.conversation.parentId}, ${schema.conversation.id}) from ${schema.conversation} where ${schema.conversation.id} = ${conversationId}) for update`,
	);

/** Subagents of one parent Conversation running at once; more wait their turn. */
export const MAX_SUBAGENTS = 4;

// so apps (the worker) can query without their own drizzle-orm dependency
export { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

/** BullMQ queues with one job `{ conversationId }` per Run: top-level Conversations', and Subagents' apart so these cannot starve them. */
export const AGENT_RUNS_QUEUE = "agent-runs";
export const SUBAGENT_RUNS_QUEUE = "subagent-runs";

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
