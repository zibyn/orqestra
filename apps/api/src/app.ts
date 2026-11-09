import type { Conversations } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { download, upload } from "./files.ts";
import type { User } from "./identity.ts";

export type { User };

/**
 * Reads the signed-in User from a request, refreshing the session when due. Every cookie in
 * cookies must reach the browser: a refresh rotates the refresh token, and the stale one reused
 * later ends the whole Polaris Session.
 */
export type Session = (
	request: Request,
) => Promise<{ user: User | null; cookies: string[] }>;

/** Polaris' /auth/login, /auth/callback and /auth/logout. */
export type Auth = (request: Request) => Response | Promise<Response>;

const unauthorized = { errors: { session: { code: "unauthorized" } } };

/** The api; production passes Polaris (see polaris.ts), tests a fake. */
export function createApp({
	session,
	auth,
	conversations,
}: {
	session: Session;
	auth: Auth;
	conversations: Conversations;
}) {
	return new Elysia()
		.all("/auth/*", ({ request }) => auth(request))
		.group("/api", (api) =>
			api
				// once per request, so that only one read may refresh
				.resolve(async ({ request, set }) => {
					const { user, cookies } = await session(request);
					if (cookies.length) set.headers["set-cookie"] = cookies;
					return { user };
				})
				.get(
					"/session",
					({ user, status }) => user ?? status(401, unauthorized),
				)
				.post(
					"/conversations/:id/uploads",
					({ user, status, params, request }) =>
						user
							? upload(conversations, user.id, params.id, request)
							: status(401, unauthorized),
					// the body is the file, streamed into the Sandbox as it arrives
					{ parse: "none" },
				)
				.get(
					"/conversations/:id/files",
					({ user, status, params, request, set }) => {
						// the file may change in the Sandbox, and is the User's alone
						set.headers["cache-control"] = "private, no-store";
						return user
							? download(conversations, user.id, params.id, request)
							: status(401, unauthorized);
					},
				),
		);
}

export type App = ReturnType<typeof createApp>;
