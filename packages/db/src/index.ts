import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema.ts";

export const db = drizzle(process.env.DATABASE_URL!, { schema });

// so apps (the worker) can query without their own drizzle-orm dependency
export { and, asc, desc, eq, ne, sql } from "drizzle-orm";

/** BullMQ queue with one job `{ conversationId }` per message to reply to. */
export const AGENT_RUNS_QUEUE = "agent-runs";

/** NOTIFY channel carrying a Conversation's ConversationEvents (worker -> web SSE). */
export const conversationChannel = (conversationId: string) =>
	`conversation_${conversationId}`;

/** NOTIFY channel whose payload is the id of the Conversation whose run should stop (web -> worker). */
export const STOP_CHANNEL = "conversation_stop";

/** NOTIFY channel, no payload: Providers or enabled Models changed, reload the config (web -> web and worker). */
export const CONFIG_CHANNEL = "config_changed";

export type ConversationEvent =
	| { type: "start" } // an Agent reply began streaming
	| { type: "delta"; kind: "text" | "thinking"; index: number; delta: string }
	| { type: "saved" }; // messages, title, status or compaction changed in the db: reload them
