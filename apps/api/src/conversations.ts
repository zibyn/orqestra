import { thinkingLevel } from "@orqestra/agents/shared";
import {
	ConversationError,
	type Conversations,
	spendingLimitStatus,
} from "@orqestra/conversations";
import { Elysia } from "elysia";
import { z } from "zod";
import { signedInOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";

const idParams = z.object({ id: z.uuid() });
export const notFound = {
	errors: { conversation: { code: "not_found" } },
} as const;

/** Everything a User does with their Conversations; another User's reads as not found. */
export const conversationRoutes = (
	signedIn: SignedIn,
	conversations: Conversations,
) =>
	new Elysia()
		.use(signedIn)
		.derive(signedInOnly)
		.onError(({ error, status }) => {
			if (!(error instanceof ConversationError)) return;
			// sent to a Conversation that is not the User's
			if (error.code === "not_found") return status(404, notFound);
			return status(422, {
				errors: { [error.field]: { code: error.code } },
			});
		})
		.get("/agent-options", () => conversations.agentOptions())
		.get("/model-options", () => conversations.modelOptions())
		.get("/conversations", ({ user }) => conversations.list(user.id))
		/** An empty Conversation to upload attachments into before its first message. */
		.post(
			"/conversations",
			async ({ user, body }) => ({
				id: await conversations.start(user.id, body.agentId, body),
			}),
			{ body: z.object({ agentId: z.string(), incognito: z.boolean() }) },
		)
		.get(
			"/conversations/:id",
			async ({ user, params, status }) =>
				(await conversations.get(user.id, params.id)) ?? status(404, notFound),
			{ params: idParams },
		)
		.patch(
			"/conversations/:id",
			async ({ user, params, body, status }) => {
				if (!(await conversations.rename(user.id, params.id, body.title)))
					return status(404, notFound);
			},
			{
				params: idParams,
				body: z.object({ title: z.string().trim().min(1).max(100) }),
			},
		)
		.delete(
			"/conversations/:id",
			async ({ user, params, status }) => {
				if (!(await conversations.delete(user.id, params.id)))
					return status(404, notFound);
			},
			{ params: idParams },
		)
		/** This month's Spending Limit of the User, for the banner that disables sending once it is used up; null without one. */
		.get("/spending-limit", async ({ user }) => ({
			status: await spendingLimitStatus(user.id),
		}))
		/**
		 * Puts a message in the Conversation's Inbox, starting one when there is no conversationId; returns its id.
		 * Refused once the User's Spending Limit is used up, whatever the composer shows.
		 */
		.post(
			"/messages",
			async ({ user, body }) => ({
				conversationId: await conversations.send(user.id, body),
			}),
			{
				body: z.object({
					conversationId: z.uuid().optional(),
					agentId: z.string().optional(),
					text: z.string().trim().min(1),
					model: z.string().optional(),
					thinking: thinkingLevel.optional(),
					// names the uploads route answered
					attachments: z.array(z.string()).max(20).optional(),
					incognito: z.boolean().optional(),
				}),
			},
		)
		.post(
			"/conversations/:id/stop",
			async ({ user, params, status }) => {
				if (!(await conversations.stop(user.id, params.id)))
					return status(404, notFound);
			},
			{ params: idParams },
		)
		.post(
			"/conversations/:id/retry",
			async ({ user, params, status }) => {
				if (!(await conversations.retry(user.id, params.id)))
					return status(404, notFound);
			},
			{ params: idParams },
		)
		/** Cancels the Timer the Agent set. */
		.delete(
			"/conversations/:id/timer",
			async ({ user, params, status }) => {
				if (!(await conversations.cancelTimer(user.id, params.id)))
					return status(404, notFound);
			},
			{ params: idParams },
		)
		/** Cancels the Background Call of one of the Agent's Tool calls in the Conversation, a Subagent's included. */
		.delete(
			"/conversations/:id/background-calls/:toolCallId",
			async ({ user, params, status }) => {
				if (
					!(await conversations.cancelBackgroundCall(
						user.id,
						params.id,
						params.toolCallId,
					))
				)
					return status(404, notFound);
			},
			{ params: idParams.extend({ toolCallId: z.string().min(1) }) },
		)
		/** The User opened the Conversation: it is no longer Unread. */
		.post(
			"/conversations/:id/seen",
			async ({ user, params, status }) => {
				if (!(await conversations.seen(user.id, params.id)))
					return status(404, notFound);
			},
			{ params: idParams },
		)
		/** Reverses the Memory change of one of the Agent's Tool calls in the Conversation. */
		.post(
			"/conversations/:id/memory-undo",
			async ({ user, params, body, status }) => {
				const { error } = await conversations.undoMemory(
					user.id,
					params.id,
					body.toolCallId,
				);
				if (error === "not_found") return status(404, notFound);
				if (error)
					return status(422, { errors: { toolCallId: { code: error } } });
			},
			{ params: idParams, body: z.object({ toolCallId: z.string().min(1) }) },
		)
		/** A Subagent's transcript, by its Conversation's id. */
		.get(
			"/subagents/:id",
			async ({ user, params, status }) =>
				(await conversations.subagentTranscript(user.id, params.id)) ??
				status(404, notFound),
			{ params: idParams },
		)
		.post(
			"/subagents/:id/stop",
			async ({ user, params, status }) => {
				if (!(await conversations.stopSubagent(user.id, params.id)))
					return status(404, notFound);
			},
			{ params: idParams },
		);
