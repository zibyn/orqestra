import type { Conversations } from "@orqestra/conversations";
import { Elysia } from "elysia";
import { z } from "zod";
import { signedInOnly } from "./admin.ts";
import type { SignedIn } from "./app.ts";

// the worker posts to it: only a push service's https URL
const endpoint = z.url({ protocol: /^https$/ }).max(2000);

/** /api/push: the browsers that receive the signed-in User's Alerts by Web Push. */
export const pushRoutes = (signedIn: SignedIn, conversations: Conversations) =>
	new Elysia({ prefix: "/push" })
		.use(signedIn)
		.derive(signedInOnly)
		// null while the instance has no VAPID keys: the browser then offers no Alerts
		.get("", () => ({ publicKey: conversations.push.publicKey() }))
		.put(
			"/subscriptions",
			async ({ user, body, status }) => {
				await conversations.push.subscribe(user.id, body);
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
				await conversations.push.unsubscribe(user.id, body.endpoint);
				return status(204);
			},
			{ body: z.object({ endpoint: z.string() }) },
		);
