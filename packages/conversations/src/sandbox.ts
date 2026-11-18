import { db } from "@orqestra/db";
import { conversation } from "@orqestra/db/schema";
import type { SandboxClient } from "@orqestra/integrations";
import { readySandbox, type SandboxProvider } from "@orqestra/tools";
import { eq } from "drizzle-orm";

/**
 * Gets the Sandbox of the Conversation's tree ready, creating it the first time: a Subagent works in its top-level
 * Conversation's, so files pass between them. Its id is kept in the top-level `conversation.sandbox_id`,
 * claimed under that row's lock so two callers at once create one. See `readySandbox` for `woke` and errors.
 */
export const ensureSandbox = (
	conversationId: string,
	client: SandboxClient,
	provider: SandboxProvider,
	options: { signal?: AbortSignal } = {},
) =>
	readySandbox(
		client,
		provider,
		(replacing, create) =>
			db.transaction(async (tx) => {
				const [own] = await tx
					.select({ rootId: conversation.rootId })
					.from(conversation)
					.where(eq(conversation.id, conversationId));
				if (!own) throw new Error("The Conversation is gone");
				// a top-level Conversation is its own root; the root goes only with its whole tree
				const [row] = await tx
					.select({ sandboxId: conversation.sandboxId })
					.from(conversation)
					.where(eq(conversation.id, own.rootId))
					.for("update");
				if (row?.sandboxId && row.sandboxId !== replacing) return row.sandboxId;
				const id = await create();
				await tx
					.update(conversation)
					.set({ sandboxId: id })
					.where(eq(conversation.id, own.rootId));
				return id;
			}),
		options,
	);
