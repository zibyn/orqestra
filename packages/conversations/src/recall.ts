import { db } from "@orqestra/db";
import { conversation, message } from "@orqestra/db/schema";
import {
	and,
	asc,
	desc,
	eq,
	gte,
	isNotNull,
	isNull,
	lte,
	max,
	ne,
	sql,
} from "drizzle-orm";

/** Messages one search returns. */
export const MAX_RECALL_RESULTS = 20;
/** Characters of a found message shown around the keyword. */
export const MAX_SNIPPET = 300;

export type Recalled = {
	conversationId: string;
	title: string | null;
	/** When the message was sent. */
	at: Date;
	snippet: string;
};

/** One User's past Conversations, as their Agent searches them: neither the current one, Subagents' nor Incognito ones. */
export type Recall = {
	/** Messages whose text contains `keyword`, ignoring case, latest first; `after` and `before` bound when they were sent. */
	search(
		keyword: string,
		range?: { after?: Date; before?: Date },
	): Promise<Recalled[]>;
	/** The Conversations with messages sent between `after` and `before`, latest first, each with its last such message's time. */
	list(range: {
		after?: Date;
		before?: Date;
	}): Promise<Omit<Recalled, "snippet">[]>;
	/** The text of a Conversation's messages, in order; undefined when it is not one `search` could find. */
	open(conversationId: string): Promise<
		| {
				title: string | null;
				messages: { role: "user" | "assistant"; text: string; at: Date }[];
		  }
		| undefined
	>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Up to MAX_SNIPPET characters of `text` around the first `keyword`, marked … where cut. */
function snippet(text: string, keyword: string) {
	if (text.length <= MAX_SNIPPET) return text;
	const hit = Math.max(0, text.toLowerCase().indexOf(keyword.toLowerCase()));
	const start = Math.max(
		0,
		Math.min(
			hit - Math.floor((MAX_SNIPPET - keyword.length) / 2),
			text.length - MAX_SNIPPET,
		),
	);
	const end = start + MAX_SNIPPET;
	return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** The past Conversations of User `userId` that Conversation `conversationId`'s Agent may recall. */
export function recallOf(userId: string, conversationId: string): Recall {
	const past = and(
		eq(conversation.userId, userId),
		isNull(conversation.parentId),
		ne(conversation.id, conversationId),
		eq(conversation.incognito, false),
	);
	return {
		search: async (keyword, { after, before } = {}) => {
			const pattern = `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;
			// pg_trgm cannot use its index for under 3 characters: scan this User's messages instead
			const text =
				[...keyword].length < 3
					? sql`coalesce(${message.text}, '')`
					: message.text;
			const rows = await db
				.select({
					conversationId: conversation.id,
					title: conversation.title,
					at: message.createdAt,
					text: message.text,
				})
				.from(message)
				.innerJoin(conversation, eq(message.conversationId, conversation.id))
				.where(
					and(
						past,
						sql`${text} ilike ${pattern}`,
						after && gte(message.createdAt, after),
						before && lte(message.createdAt, before),
					),
				)
				.orderBy(desc(message.createdAt), desc(message.id))
				.limit(MAX_RECALL_RESULTS);
			return rows.map(({ text, ...r }) => ({
				...r,
				snippet: snippet(text ?? "", keyword),
			}));
		},
		list: async ({ after, before }) => {
			const at = max(message.createdAt);
			return db
				.select({
					conversationId: conversation.id,
					title: conversation.title,
					at: sql<Date>`${at}`.mapWith(message.createdAt),
				})
				.from(message)
				.innerJoin(conversation, eq(message.conversationId, conversation.id))
				.where(
					and(
						past,
						isNotNull(message.text),
						after && gte(message.createdAt, after),
						before && lte(message.createdAt, before),
					),
				)
				.groupBy(conversation.id)
				.orderBy(desc(at))
				.limit(MAX_RECALL_RESULTS);
		},
		open: async (id) => {
			if (!UUID.test(id)) return undefined;
			const [conv] = await db
				.select({ title: conversation.title })
				.from(conversation)
				.where(and(past, eq(conversation.id, id)));
			if (!conv) return undefined;
			const rows = await db
				.select({
					m: message.message,
					text: message.text,
					at: message.createdAt,
				})
				.from(message)
				.where(and(eq(message.conversationId, id), isNotNull(message.text)))
				.orderBy(asc(message.id));
			return {
				title: conv.title,
				messages: rows.map((r) => ({
					role: (r.m as { role: "user" | "assistant" }).role,
					text: r.text as string,
					at: r.at,
				})),
			};
		},
	};
}
