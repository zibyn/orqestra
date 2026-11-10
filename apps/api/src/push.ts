import type { Conversations } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { z } from "zod";
import { signedInOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";

// the worker posts to it, so only the https URL of a browser's push service: Chrome's, Firefox's, Safari's or Edge's
const endpoint = z
	.url({
		protocol: /^https$/,
		hostname:
			/^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/,
	})
	.max(2000);

/** /api/push: the browsers that receive the signed-in User's Alerts by Web Push. */
export const pushRoutes = (signedIn: SignedIn, conversations: Conversations) =>
	new Elysia({ prefix: "/push" })
		.use(signedIn)
		.derive(signedInOnly)
		// null while the instance has no VAPID keys: the browser then offers no Alerts
		.get("", () => ({ publicKey: conversations.alerts.publicKey() }))
		.put(
			"/subscriptions",
			async ({ user, body, status }) => {
				await conversations.alerts.subscribe(user.id, body);
				return status(204);
			},
			{
				body: z.object({
					endpoint,
					keys: z.object({
						p256dh: z.string().min(1).max(200),
						auth: z.string().min(1).max(200),
					}),
				}),
			},
		)
		.delete(
			"/subscriptions",
			async ({ user, body, status }) => {
				await conversations.alerts.unsubscribe(user.id, body.endpoint);
				return status(204);
			},
			{ body: z.object({ endpoint: z.string() }) },
		);
