import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import { agents } from "./agents.ts";
import type { User } from "./identity.ts";
import { mcpServers } from "./mcp-servers.ts";
import { providers } from "./providers.ts";
import { sandboxProvider } from "./sandbox-provider.ts";
import { searchProviders } from "./search-providers.ts";

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

/** The api; production passes Polaris (see polaris.ts), tests a fake. */
export function createApp({ session, auth }: { session: Session; auth: Auth }) {
	return (
		new Elysia()
			// invalid input is 422 with an error per field, like a save's own field errors
			.onError(({ code, error, status }) => {
				if (code !== "VALIDATION") return;
				const errors: Record<string, { code: "invalid"; detail: string }> = {};
				for (const { path, message } of error.all as {
					path: string;
					message: string;
				}[])
					errors[path === "root" ? "" : path] ??= {
						code: "invalid",
						detail: message,
					};
				return status(422, { errors });
			})
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
						({ user, status }) =>
							user ??
							status(401, { errors: { session: { code: "unauthorized" } } }),
					)
					// the console's, for Admins only
					.guard({}, (admin) =>
						admin
							.onBeforeHandle(adminOnly)
							.use(providers)
							.use(searchProviders)
							.use(mcpServers)
							.use(sandboxProvider)
							.use(agents),
					),
			)
	);
}

export type App = ReturnType<typeof createApp>;
