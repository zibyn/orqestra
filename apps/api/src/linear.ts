import {
	accountOf,
	accountState,
	callbackUrl,
	conversationsInput,
	type Fetch,
	finishAccount,
	finishInstallation,
	installationInput,
	installationStatus,
	saveConversations,
	startAccount,
	startInstallation,
	unlinkAccount,
	webhookUrl,
} from "@orqestra/integrations";
import { linear } from "@orqestra/integrations/linear";
import { Elysia } from "elysia";
import { adminOnly, signedInOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// Orqestra's Linear app, an Integration Installation an Admin installs in /console/linear, its secrets and tokens only going in; and
// each User's Integration Account, linked from the Connections page by authorizing as themselves through the same app.
export const linearRoutes = (
	signedIn: SignedIn,
	{ orqestraUrl, fetch }: { orqestraUrl: string; fetch?: Fetch },
) =>
	new Elysia({ prefix: "/linear" })
		.use(signedIn)
		// Linear sends both back here: a User linking their account, on to the Connections page; an Admin installing, on to the console
		.get("/callback", async ({ user, request, redirect }) => {
			const query = new URL(request.url).searchParams;
			if (accountState(linear, query.get("state"))) {
				const error = user
					? await finishAccount(linear, user.id, query, { orqestraUrl, fetch })
					: "state_invalid";
				const to = new URLSearchParams(
					error ? { error } : { linked: linear.kind },
				);
				return redirect(`/connections?${to}`, 302);
			}
			if (!user?.admin) return adminOnly({ user });
			const error = await finishInstallation(linear, query, {
				orqestraUrl,
				fetch,
			});
			return redirect(
				error ? `/console/linear?error=${error}` : "/console/linear",
				302,
			);
		})
		.use(
			new Elysia()
				.use(signedIn)
				.derive(signedInOnly)
				// whether the app is installed, and the Linear account the User linked
				.get("/account", async ({ user }) => ({
					installed: !!(await installationStatus(linear))?.workspace,
					account: await accountOf(linear, user.id),
				}))
				// the Linear URL to send the User to
				.post("/account", async ({ user, status }) => {
					const url = await startAccount(linear, user.id, orqestraUrl);
					return url
						? { url }
						: status(404, { errors: { "": { code: "not_found" } } });
				})
				.delete("/account", async ({ user }) => {
					await unlinkAccount(linear, user.id);
					return null;
				}),
		)
		.derive(adminOnly)
		.get("/", async () => ({
			installation: await installationStatus(linear),
			callbackUrl: callbackUrl(linear, orqestraUrl),
			webhookUrl: webhookUrl(linear, orqestraUrl),
		}))
		// the Agent and repositories of the Conversations Linear opens
		.put(
			"/conversations",
			async ({ body }) => saved(await saveConversations(linear, body)),
			{ body: conversationsInput },
		)
		// once the credentials are saved, the Linear URL to send the Admin to
		.post(
			"/",
			async ({ body }) =>
				saved(await startInstallation(linear, body, orqestraUrl)),
			{ body: installationInput },
		);
