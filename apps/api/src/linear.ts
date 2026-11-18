import {
	type Fetch,
	finishInstallation,
	linearCallbackUrl,
	linearInstallationInput,
	linearInstallationStatus,
	startInstallation,
} from "@orqestra/linear";
import { Elysia } from "elysia";
import { adminOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";
import { saved } from "./saved.ts";

// Orqestra's Linear app, installed by an Admin in /console/linear. Its secrets and tokens only go in.
export const linearRoutes = (
	signedIn: SignedIn,
	{ orqestraUrl, fetch }: { orqestraUrl: string; fetch?: Fetch },
) =>
	new Elysia({ prefix: "/linear" })
		.use(signedIn)
		.derive(adminOnly)
		.get("/", async () => ({
			installation: await linearInstallationStatus(),
			callbackUrl: linearCallbackUrl(orqestraUrl),
		}))
		// once the credentials are saved, the Linear URL to send the Admin to
		.post(
			"/",
			async ({ body }) => saved(await startInstallation(body, orqestraUrl)),
			{ body: linearInstallationInput },
		)
		// Linear sends the Admin back here, then on to the console page
		.get("/callback", async ({ request, redirect }) => {
			const error = await finishInstallation(
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
