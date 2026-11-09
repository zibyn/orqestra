import type { Conversations } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { z } from "zod";
import { conversationRoutes } from "./conversations.ts";
import { download, upload } from "./files.ts";
import type { User } from "./identity.ts";
import { memoryRoutes } from "./memories.ts";
import { skills } from "./skills.ts";

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

/** `user` for the routes of whoever uses it; by its name, the session is read once per request however many do. */
const signedIn = (session: Session) =>
	new Elysia({ name: "signed-in" }).resolve(
		{ as: "scoped" },
		async ({ request, set }) => {
			const { user, cookies } = await session(request);
			if (cookies.length) set.headers["set-cookie"] = cookies;
			return { user };
		},
	);
export type SignedIn = ReturnType<typeof signedIn>;

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
	const user = signedIn(session);
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
				.use(skills(user))
				.use(conversationRoutes(user, conversations))
				.get(
					"/session",
					({ user, status }) => user ?? status(401, unauthorized),
				)
				// a Conversation's live events as server-sent events, until the client goes; see conversations.subscribe
				.get(
					"/conversations/:id/events",
					async ({ user, params, request, set, status }) => {
						if (!user) return status(401, unauthorized);
						const id = z.uuid().safeParse(params.id);
						const stream =
							id.success &&
							(await conversations.subscribe(user.id, id.data, request.signal));
						if (!stream)
							return status(404, {
								errors: { conversation: { code: "not_found" } },
							});
						set.headers["content-type"] = "text/event-stream";
						set.headers["cache-control"] = "no-cache";
						return new Response(stream);
					},
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
				)
				.use(memoryRoutes(user)),
		);
}

export type App = ReturnType<typeof createApp>;
