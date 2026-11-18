// Integration Sessions (ADR 0018): a WorkSource's session (Linear's Agent Session) is one Conversation, and each of its Runs closes the
// session's turn once, with its reply, its Question, its failure or the stop the session asked for.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { db } from "@orqestra/db";
import {
	conversation,
	type IntegrationKind,
	integrationSession,
	user,
} from "@orqestra/db/schema";
import {
	type Activity,
	conversationSettings,
	type Fetch,
	postActivity,
	type SessionEvent,
	type WorkSource,
} from "@orqestra/integrations";
import { linear } from "@orqestra/integrations/linear";
import { and, desc, eq, sql } from "drizzle-orm";
import { ConversationError } from "./errors.ts";
import type { Conversations } from "./index.ts";
import { type RunHandler, RunTimedOut } from "./serve.ts";
import { messageText } from "./shared.ts";
import { SpendingLimitReached } from "./spending.ts";

/** Each kind's WorkSource, which a session's activities go to. */
const SOURCES: Record<IntegrationKind, WorkSource> = { linear };

/**
 * The session of the Conversation whose Run, job `jobId`'s, is closing its turn, which it then records closed: undefined when the
 * Conversation has no session or that turn was closed already. Its reply, its failure and the stop the session asked for each close
 * it, so the first of them posts the one closing activity.
 */
const closing = async (conversationId: string, jobId: string) => {
	const [session] = await db
		.update(integrationSession)
		.set({ closedJobId: jobId })
		.where(
			and(
				eq(integrationSession.conversationId, conversationId),
				sql`${integrationSession.closedJobId} is distinct from ${jobId}`,
			),
		)
		.returning({
			kind: integrationSession.kind,
			id: integrationSession.sessionId,
		});
	return session;
};

/** Posts a closing activity, logging rather than throwing when the WorkSource cannot take it. */
const postClosing = (
	session: { kind: IntegrationKind; id: string },
	activity: Activity,
	fetch?: Fetch,
) =>
	postActivity(SOURCES[session.kind], session.id, activity, { fetch }).catch(
		(error) =>
			console.error(
				`could not post to ${SOURCES[session.kind].name} session ${session.id}`,
				error,
			),
	);

/**
 * Acts on a session's event: the first one from a session opens its Conversation, as the Orqestra User with the sender's email, and the
 * app says so in the session; a later prompt goes to that Conversation, a stop stops it and says so. Anything the session should hear
 * of instead is posted to it as an error. Converges when run again: a session opens one Conversation however often it is delivered.
 */
export async function handleSessionEvent(
	source: WorkSource,
	event: SessionEvent,
	conversations: Pick<Conversations, "send" | "stop">,
	{ fetch }: { fetch?: Fetch } = {},
) {
	const post = (type: "thought" | "response" | "error", body: string) =>
		postActivity(source, event.sessionId, { type, body }, { fetch });
	const [session] = await db
		.select({
			conversationId: integrationSession.conversationId,
			userId: conversation.userId,
		})
		.from(integrationSession)
		.innerJoin(
			conversation,
			eq(conversation.id, integrationSession.conversationId),
		)
		.where(
			and(
				eq(integrationSession.kind, source.kind),
				eq(integrationSession.sessionId, event.sessionId),
			),
		);
	if (event.stop) {
		const stopped =
			session &&
			(await conversations.stop(session.userId, session.conversationId));
		// the session waits for a final activity confirming the stop, unless the turn it stops closed already, with its reply or failure
		if (
			stopped &&
			!(await closing(session.conversationId, stopped.jobId ?? ""))
		)
			return;
		return post("response", "Stopped.");
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
					origin: source.kind,
				});
			return;
		}
		if (!session) {
			const settings = await conversationSettings(source);
			await conversations
				.send(sender.id, {
					agentId: settings?.defaultAgentId ?? undefined,
					text: source.firstMessage(
						event,
						event.issue ? settings?.teamRepos[event.issue.teamKey] : undefined,
					),
					origin: source.kind,
					session: { kind: source.kind, id: event.sessionId },
				})
				.catch((error) => {
					// opened by this event's earlier delivery, which may not have said so
					if (
						!(
							error instanceof ConversationError &&
							error.code === "session_open"
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

/**
 * Closes the turn of a session's Conversation whose Run, job `jobId`'s, was marked failed (`onFailed`), however it failed: in `reply`,
 * before it (its Agent removed), or on a worker that crashed or was killed; unless the stop the session asked for closed it first.
 * shortcut: a worker dying between a Run's end and its post leaves the turn open; post from an outbox of closings if that bites.
 */
export async function reportSessionFailure(
	conversationId: string,
	error: Error,
	jobId: string,
	{ fetch }: { fetch?: Fetch } = {},
) {
	const session = await closing(conversationId, jobId);
	if (!session) return;
	await postClosing(
		session,
		{
			type: "error",
			body:
				error instanceof SpendingLimitReached
					? "This month's Spending Limit is used up, so the request was not sent."
					: "This reply failed. Retry it in Orqestra.",
		},
		fetch,
	);
}

/**
 * Replies to a Run with `reply`, and, for a session's Conversation, posts one activity into the session that closes its turn, the
 * moment the Run is over and before the Conversation is titled: what it said last, as an elicitation when it ended asking the User a
 * question, else as the response, which says there was nothing to report when it said nothing; a Run cut off by the unattended time
 * limit, as an error with what it had written; unless the stop the session asked for closed the turn first. A Run the User stopped
 * posts nothing (the stop request confirms it in the session); one that failed is posted by `reportSessionFailure`.
 */
export const reportingToSessions =
	(reply: RunHandler, { fetch }: { fetch?: Fetch } = {}): RunHandler =>
	async (run, config) => {
		const [session] = await db
			.select({ id: integrationSession.sessionId })
			.from(integrationSession)
			.where(eq(integrationSession.conversationId, run.conversationId));
		if (!session) return reply(run, config);
		// the Run's end, or its being cut off, closes the turn once; a stop leaves that to its confirmation
		const close = async (content?: Activity) => {
			if (!content) return;
			const claimed = await closing(run.conversationId, run.jobId);
			if (claimed) await postClosing(claimed, content, fetch);
		};
		const replies: AssistantMessage[] = [];
		const said = () =>
			replies
				.map((m) => messageText(m).trim())
				.filter(Boolean)
				.at(-1);
		// a response "indicates work has been completed", which a cut-off one has not
		const cutOff = (): Activity => ({
			type: "error",
			body: [
				"Partly done: this ran out of time and stopped before it finished. Reply here to carry on.",
				said() && `What it had written when it stopped:\n\n${said()}`,
			]
				.filter(Boolean)
				.join("\n\n"),
		});
		const ended = (): Activity => {
			const last = replies.at(-1);
			const asked = last?.content.find(
				(c) => c.type === "toolCall" && c.name === "ask_user",
			);
			if (last && asked?.type === "toolCall") {
				const { question, suggestions = [] } = asked.arguments as {
					question: string;
					suggestions?: string[];
				};
				return {
					type: "elicitation",
					body: [
						messageText(last).trim(),
						question,
						suggestions.map((s) => `- ${s}`).join("\n"),
					]
						.filter(Boolean)
						.join("\n\n"),
				};
			}
			const quiet = last?.content.find(
				(c) => c.type === "toolCall" && c.name === "nothing_to_report",
			);
			// it found nothing to report: that, not what it said on its way
			if (last && quiet?.type === "toolCall") {
				const { reason } = quiet.arguments as { reason?: string };
				return {
					type: "response",
					body:
						messageText(last).trim() ||
						(reason ? `Nothing to report: ${reason}` : "Nothing to report."),
				};
			}
			// a response is what closes the turn, so one goes out however little was said
			return { type: "response", body: said() ?? "Nothing to report." };
		};
		try {
			await reply(
				{
					...run,
					async save(message) {
						await run.save(message);
						if (message.role === "assistant") replies.push(message);
					},
					async finish(outcome, options) {
						// as `finish` finds it: a limit passing later, while the Run is titled, leaves it completed
						const { aborted, reason } = run.signal;
						const next = await run.finish(outcome, options);
						if (!next.length)
							await close(
								!aborted
									? ended()
									: reason instanceof RunTimedOut
										? cutOff()
										: undefined,
							);
						return next;
					},
				},
				config,
			);
		} catch (error) {
			if (run.signal.reason instanceof RunTimedOut) await close(cutOff());
			throw error;
		}
	};
