import { ConversationError, type Conversations } from "@orqestra/conversations";
import { db } from "@orqestra/db";
import { conversation, linearSession, user } from "@orqestra/db/schema";
import type { Fetch } from "@orqestra/linear";
import { type LinearEvent, postAgentActivity } from "@orqestra/linear/events";
import { desc, eq, sql } from "drizzle-orm";

/** The first message of a Conversation a Linear Agent Session opens: its issue, the repository its team works in, and what it was started with. */
const firstMessage = (event: LinearEvent, repo: string | undefined) =>
	[
		event.issue &&
			`Linear issue ${event.issue.identifier}: ${event.issue.title}\n${event.issue.url}`,
		repo && `Repository: ${repo}`,
		event.issue?.description,
		event.text,
	]
		.filter(Boolean)
		.join("\n\n") || "A Linear Agent Session started with no issue or comment.";

/**
 * Acts on an Agent Session event (ADR 0015): the first one from a session opens its Conversation, as the Orqestra User with the sender's
 * email, and the app says so in the session; a later prompt goes to that Conversation, a stop stops it. Anything Linear should hear of
 * instead is posted to the session as an error. Converges when run again: a session opens one Conversation however often it is delivered.
 */
export async function handleLinearEvent(
	event: LinearEvent,
	conversations: Pick<Conversations, "send" | "stop">,
	{ fetch }: { fetch?: Fetch } = {},
) {
	const post = (type: "thought" | "error", body: string) =>
		postAgentActivity(event.agentSessionId, { type, body }, { fetch });
	const [session] = await db
		.select({
			conversationId: linearSession.conversationId,
			userId: conversation.userId,
		})
		.from(linearSession)
		.innerJoin(conversation, eq(conversation.id, linearSession.conversationId))
		.where(eq(linearSession.agentSessionId, event.agentSessionId));
	if (event.stop) {
		if (session)
			await conversations.stop(session.userId, session.conversationId);
		return;
	}
	const email = event.from?.email;
	const [sender] = email
		? await db
				.select({ id: user.id })
				.from(user)
				.where(sql`lower(${user.email}) = lower(${email})`)
				.orderBy(desc(user.lastActiveAt))
				.limit(1)
		: [];
	if (!sender)
		return post(
			"error",
			`Sign in to Orqestra${email ? ` as ${email}` : ""} first, then reply here.`,
		);
	// it runs as its User, with their Connections: nobody else may direct it
	if (session && session.userId !== sender.id)
		return post(
			"error",
			"Only the person who started this session can direct it.",
		);
	try {
		if (session && event.action === "prompted") {
			if (event.text)
				await conversations.send(sender.id, {
					conversationId: session.conversationId,
					text: event.text,
					origin: "linear",
				});
			return;
		}
		if (!session) {
			const installation = await db.query.linearInstallation.findFirst({
				columns: { defaultAgentId: true, teamRepos: true },
			});
			await conversations
				.send(sender.id, {
					agentId: installation?.defaultAgentId ?? undefined,
					text: firstMessage(
						event,
						event.issue
							? installation?.teamRepos[event.issue.teamKey]
							: undefined,
					),
					origin: "linear",
					linearSessionId: event.agentSessionId,
				})
				.catch((error) => {
					// opened by this event's earlier delivery, which may not have said so
					if (
						!(
							error instanceof ConversationError &&
							error.code === "linear_session_open"
						)
					)
						throw error;
				});
		}
		// Linear marks a session unresponsive without an activity within 10 seconds of its start
		await post("thought", "Working on this in Orqestra.");
	} catch (error) {
		if (!(error instanceof ConversationError)) throw error;
		await post("error", error.message);
	}
}
