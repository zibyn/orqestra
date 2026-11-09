import type { Conversations } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { conversationRoutes } from "./conversations.ts";
import type { User } from "./identity.ts";
import { type Session, sessionPlugin, unauthorized } from "./session.ts";

export type { Session, User };

/** Polaris' /auth/login, /auth/callback and /auth/logout. */
export type Auth = (request: Request) => Response | Promise<Response>;

/** The api; production passes Polaris (see polaris.ts) and the real services, tests fakes. */
export function createApp({
	session,
	auth,
	conversations,
}: {
	session: Session;
	auth: Auth;
	conversations: Conversations;
}) {
	const user = sessionPlugin(session);
	return new Elysia()
		.all("/auth/*", ({ request }) => auth(request))
		.group("/api", (api) =>
			api
				// invalid input: every field zod refused, with its message
				.onError(({ code, error, status }) => {
					if (code !== "VALIDATION") return;
					return status(422, {
						errors: Object.fromEntries(
							error.all.map((issue) => [
								// `/thinking/default` as `thinking.default`, the console's field names
								"path" in issue
									? String(issue.path).replace(/^\//, "").replaceAll("/", ".")
									: "",
								{ code: "invalid", detail: issue.summary ?? issue.message },
							]),
						),
					});
				})
				.use(user)
				.get(
					"/session",
					({ user, status }) => user ?? status(401, unauthorized),
				)
				.use(conversationRoutes(user, conversations)),
		);
}

export type App = ReturnType<typeof createApp>;
