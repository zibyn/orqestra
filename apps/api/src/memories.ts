import {
	InvalidMemory,
	MAX_MEMORY_BODY,
	MAX_MEMORY_DESCRIPTION,
	MemoryNotFound,
	userMemories,
} from "@orqestra/memory";
import { Elysia, t } from "elysia";
import { unauthorized } from "./admin.ts";
import type { SignedIn } from "./app.ts";

const notFound = { errors: { path: { code: "not_found" as const } } };

/** /api/memories: the signed-in User's own Memories and memory switch; nobody else's, Admins included. */
export const memoryRoutes = (signedIn: SignedIn) =>
	new Elysia({ prefix: "/memories" }).use(signedIn).group("", (memories) =>
		memories
			// a derive, so a signed-out request is refused before its body is validated
			.derive(({ user, status }) =>
				user ? { mine: userMemories(user.id) } : status(401, unauthorized),
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
						await mine.update(path, description, body);
						return status(204);
					} catch (e) {
						if (e instanceof InvalidMemory)
							return status(422, {
								errors: {
									"": { code: "invalid" as const, detail: e.message },
								},
							});
						if (e instanceof MemoryNotFound) return status(404, notFound);
						throw e;
					}
				},
				{
					body: t.Object({
						path: t.String(),
						description: t.String(),
						body: t.String(),
					}),
				},
			)
			.delete("/:path", async ({ mine, params, status }) => {
				try {
					await mine.delete(params.path);
					return status(204);
				} catch (e) {
					if (e instanceof MemoryNotFound) return status(404, notFound);
					throw e;
				}
			})
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
