import { db } from "@orqestra/db";
import { conversation } from "@orqestra/db/schema";
import {
	type Orrery,
	readySandbox,
	type SandboxProvider,
} from "@orqestra/tools";
import { eq } from "drizzle-orm";

/**
 * Gets the Conversation's Sandbox ready, creating it the first time; its id is kept in `conversation.sandbox_id`,
 * claimed under the row's lock so two callers at once create one. See `readySandbox` for `woke` and errors.
 */
export const ensureSandbox = (
	conversationId: string,
	client: Orrery,
	provider: SandboxProvider,
	options: { signal?: AbortSignal } = {},
) =>
	readySandbox(
		client,
		provider,
		(replacing, create) =>
			db.transaction(async (tx) => {
				const [row] = await tx
					.select({ sandboxId: conversation.sandboxId })
					.from(conversation)
					.where(eq(conversation.id, conversationId))
					.for("update");
				if (!row) throw new Error("The Conversation is gone");
				if (row.sandboxId && row.sandboxId !== replacing) return row.sandboxId;
				const id = await create();
				await tx
					.update(conversation)
					.set({ sandboxId: id })
					.where(eq(conversation.id, conversationId));
				return id;
			}),
		options,
	);
