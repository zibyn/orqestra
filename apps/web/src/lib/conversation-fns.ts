import { thinkingLevel } from "@orqestra/config/shared";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import * as conversations from "#/lib/conversations";
import { requireUserId } from "#/lib/session";

const id = z.uuid();

export const getAgentOptions = createServerFn().handler(async () => {
	await requireUserId();
	return conversations.listAgentOptions();
});

export const listConversations = createServerFn().handler(async () =>
	conversations.listConversations(await requireUserId()),
);

export const getConversation = createServerFn()
	.validator(id)
	.handler(
		async ({ data }) =>
			(await conversations.getConversation(await requireUserId(), data)) ??
			null,
	);

export const getSubagentMessages = createServerFn()
	.validator(id)
	.handler(
		async ({ data }) =>
			(await conversations.getSubagentMessages(await requireUserId(), data)) ??
			null,
	);

export const stopSubagent = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) =>
		conversations.stopSubagent(await requireUserId(), data),
	);

export const sendMessage = createServerFn({ method: "POST" })
	.validator(
		z.object({
			conversationId: id.optional(),
			agentId: z.string().optional(),
			text: z.string().trim().min(1),
			model: z.string().optional(),
			thinking: thinkingLevel.optional(),
		}),
	)
	.handler(async ({ data }) =>
		conversations.sendMessage(await requireUserId(), data),
	);

export const stopRun = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) =>
		conversations.stopRun(await requireUserId(), data),
	);

export const retryRun = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) =>
		conversations.retryRun(await requireUserId(), data),
	);

export const renameConversation = createServerFn({ method: "POST" })
	.validator(z.object({ id, title: z.string().trim().min(1).max(100) }))
	.handler(async ({ data }) =>
		conversations.renameConversation(
			await requireUserId(),
			data.id,
			data.title,
		),
	);

export const deleteConversation = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) =>
		conversations.deleteConversation(await requireUserId(), data),
	);
