import { thinkingLevel } from "@orqestra/config/shared";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { conversations } from "#/lib/conversations";
import { requireUserId } from "#/lib/session";

const id = z.uuid();

export const getAgentOptions = createServerFn().handler(async () => {
	await requireUserId();
	return conversations.agentOptions();
});

export const listConversations = createServerFn().handler(async () =>
	conversations.list(await requireUserId()),
);

export const getConversation = createServerFn()
	.validator(id)
	.handler(
		async ({ data }) =>
			(await conversations.get(await requireUserId(), data)) ?? null,
	);

export const getSubagentMessages = createServerFn()
	.validator(id)
	.handler(
		async ({ data }) =>
			(await conversations.subagentTranscript(await requireUserId(), data)) ??
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
	.handler(async ({ data }) => conversations.send(await requireUserId(), data));

export const stopRun = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) => conversations.stop(await requireUserId(), data));

export const retryRun = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) =>
		conversations.retry(await requireUserId(), data),
	);

export const renameConversation = createServerFn({ method: "POST" })
	.validator(z.object({ id, title: z.string().trim().min(1).max(100) }))
	.handler(async ({ data }) =>
		conversations.rename(await requireUserId(), data.id, data.title),
	);

export const deleteConversation = createServerFn({ method: "POST" })
	.validator(id)
	.handler(async ({ data }) =>
		conversations.delete(await requireUserId(), data),
	);
