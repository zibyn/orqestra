import type { Conversations } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { z } from "zod";
import { signedInOnly } from "./admin.ts";
import { agents } from "./agents.ts";
import { conversationRoutes, notFound } from "./conversations.ts";
import { documentParser } from "./document-parser.ts";
import { download, upload } from "./files.ts";
import type { User } from "./identity.ts";
import { limits } from "./limits.ts";
import { mcpServers } from "./mcp-servers.ts";
import { memoryRoutes } from "./memories.ts";
import { providers } from "./providers.ts";
import { pushRoutes } from "./push.ts";
import { sandboxProvider } from "./sandbox-provider.ts";
import { scheduledTaskRoutes } from "./scheduled-tasks.ts";
import { searchProviders } from "./search-providers.ts";
import { skills } from "./skills.ts";

export type { ConversationEvent } from "@orqestra/conversations";
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

/**
 * `user` for the routes of whoever uses it; by its name, the session is read once per request however many do.
 * A derive, so the guards in admin.ts can refuse a request before its body is validated.
 */
const signedIn = (session: Session) =>
	new Elysia({ name: "signed-in" }).derive(
		{ as: "scoped" },
		async ({ request, set }) => {
			const { user, cookies } = await session(request);
			if (cookies.length) set.headers["set-cookie"] = cookies;
			return { user };
		},
	);
export type SignedIn = ReturnType<typeof signedIn>;

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
				.use(scheduledTaskRoutes(user, conversations))
				.use(pushRoutes(user, conversations))
				.use(providers(user))
				.use(searchProviders(user))
				.use(mcpServers(user))
				.use(sandboxProvider(user))
				.use(documentParser(user))
				.use(limits(user))
				.use(agents(user))
				.derive(signedInOnly)
				.get("/session", ({ user }) => user)
				// a Conversation's live events as server-sent events, until the client goes; see conversations.subscribe
				.get(
					"/conversations/:id/events",
					async ({ user, params, request, set, status }) => {
						const id = z.uuid().safeParse(params.id);
						const stream =
							id.success &&
							(await conversations.subscribe(user.id, id.data, request.signal));
						if (!stream) return status(404, notFound);
						set.headers["content-type"] = "text/event-stream";
						set.headers["cache-control"] = "no-cache";
						return new Response(stream);
					},
				)
				.post(
					"/conversations/:id/uploads",
					({ user, params, request }) =>
						upload(conversations, user.id, params.id, request),
					// the body is the file, streamed into the Sandbox as it arrives
					{ parse: "none" },
				)
				.get("/conversations/:id/files", ({ user, params, request, set }) => {
					// the file may change in the Sandbox, and is the User's alone
					set.headers["cache-control"] = "private, no-store";
					return download(conversations, user.id, params.id, request);
				})
				.use(memoryRoutes(user)),
		);
}

export type App = ReturnType<typeof createApp>;
