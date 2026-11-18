import {
	callbackUrl,
	conversationsInput,
	type Fetch,
	finishInstallation,
	installationInput,
	installationStatus,
	saveConversations,
	startInstallation,
	webhookUrl,
} from "@orqestra/integrations";
import { linear } from "@orqestra/integrations/linear";
import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// Orqestra's Linear app, an Integration Installation an Admin installs in /console/linear. Its secrets and tokens only go in.
export const linearRoutes = (
	signedIn: SignedIn,
	{ orqestraUrl, fetch }: { orqestraUrl: string; fetch?: Fetch },
) =>
	new Elysia({ prefix: "/linear" })
		.use(signedIn)
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
		)
		// Linear sends the Admin back here, then on to the console page
		.get("/callback", async ({ request, redirect }) => {
			const error = await finishInstallation(
				linear,
				new URL(request.url).searchParams,
				{
					orqestraUrl,
					fetch,
				},
			);
			return redirect(
				error ? `/console/linear?error=${error}` : "/console/linear",
				302,
			);
		});
