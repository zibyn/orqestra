import { linearWebhookEvent, queueLinearEvent } from "@orqestra/linear/events";
import { Elysia } from "elysia";

// Linear's webhook for Orqestra's app, signed with its webhook secret rather than signed in: it only queues the event for the
// worker, since Linear counts a delivery that takes over 5 seconds as failed
export const linearWebhook = new Elysia().post(
	"/linear/webhook",
	async ({ request, status }) => {
		const event = await linearWebhookEvent(
			await request.text(),
			request.headers.get("linear-signature"),
		);
		if (event === undefined)
			return status(401, { errors: { signature: { code: "invalid" } } });
		if (event) await queueLinearEvent(event);
		return status(200, null);
	},
	// the signature is over the raw body
	{ parse: "none" },
);
