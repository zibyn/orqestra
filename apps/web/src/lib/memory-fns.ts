import {
	MAX_MEMORY_BODY,
	MAX_MEMORY_DESCRIPTION,
	userMemories,
} from "@orqestra/conversations";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUserId } from "#/lib/session";

// The signed-in User's own Memories and memory switch, for /memory; nobody else's, Admins included

const mine = async () => userMemories(await requireUserId());

export const getMemories = createServerFn().handler(async () => {
	const memories = await mine();
	const [list, on] = await Promise.all([memories.list(), memories.on()]);
	return {
		memories: list,
		on,
		limits: { description: MAX_MEMORY_DESCRIPTION, body: MAX_MEMORY_BODY },
	};
});

/** Under the same limits as the Memory Tools; throws when over them or gone. */
export const saveMemory = createServerFn({ method: "POST" })
	.validator(
		z.object({ path: z.string(), description: z.string(), body: z.string() }),
	)
	.handler(async ({ data }) =>
		(await mine()).update(data.path, data.description, data.body),
	);

export const deleteMemory = createServerFn({ method: "POST" })
	.validator(z.string())
	.handler(async ({ data }) => (await mine()).delete(data));

export const deleteAllMemories = createServerFn({ method: "POST" }).handler(
	async () => {
		await (await mine()).deleteAll();
	},
);

export const setMemoryOn = createServerFn({ method: "POST" })
	.validator(z.boolean())
	.handler(async ({ data }) => {
		await (await mine()).setOn(data);
	});
