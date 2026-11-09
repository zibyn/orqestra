import {
	checkMemory,
	MAX_MEMORY_BODY,
	MAX_MEMORY_DESCRIPTION,
	MemoryError,
	userMemories,
} from "@orqestra/conversations";
import { Elysia, t } from "elysia";
import type { SignedIn } from "./app.ts";

const notFound = { errors: { path: { code: "not_found" as const } } };

/** /api/memories: the signed-in User's own Memories and memory switch; nobody else's, Admins included. */
export const memoryRoutes = (signedIn: SignedIn) =>
	new Elysia({ prefix: "/memories" }).use(signedIn).group("", (memories) =>
		memories
			.resolve(({ user, status }) =>
				user
					? { mine: userMemories(user.id) }
					: status(401, { errors: { session: { code: "unauthorized" } } }),
			)
			.get("", async ({ mine }) => {
				const [list, on] = await Promise.all([mine.list(), mine.on()]);
				return {
					memories: list,
					on,
					limits: {
						description: MAX_MEMORY_DESCRIPTION,
						body: MAX_MEMORY_BODY,
					},
				};
			})
			// under the same limits as the Memory Tools
			.put(
				"",
				async ({ mine, body: { path, description, body }, status }) => {
					try {
						checkMemory(path, description, body);
					} catch (e) {
						if (!(e instanceof MemoryError)) throw e;
						return status(422, {
							errors: { "": { code: "invalid" as const, detail: e.message } },
						});
					}
					// past checkMemory, a MemoryError means there is no such Memory of the User's
					return (await found(() => mine.update(path, description, body)))
						? status(204)
						: status(404, notFound);
				},
				{
					body: t.Object({
						path: t.String(),
						description: t.String(),
						body: t.String(),
					}),
				},
			)
			.delete("/:path", async ({ mine, params, status }) =>
				(await found(() => mine.delete(params.path)))
					? status(204)
					: status(404, notFound),
			)
			.delete("", async ({ mine, status }) => {
				await mine.deleteAll();
				return status(204);
			})
			.put(
				"/on",
				async ({ mine, body, status }) => {
					await mine.setOn(body.on);
					return status(204);
				},
				{ body: t.Object({ on: t.Boolean() }) },
			),
	);

/** Whether change found the Memory it changes. */
async function found(change: () => Promise<unknown>) {
	try {
		await change();
		return true;
	} catch (e) {
		if (e instanceof MemoryError) return false;
		throw e;
	}
}
