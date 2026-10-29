import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { auth } from "#/lib/auth";
import { conversations } from "#/lib/conversations";

// SSE stream of a Conversation's live events; see conversations.subscribe
export const Route = createFileRoute("/api/conversations/$id/events")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const session = await auth.api.getSession({ headers: request.headers });
				if (!session) return new Response(null, { status: 401 });
				const id = z.uuid().safeParse(params.id);
				const stream =
					id.success &&
					(await conversations.subscribe(
						session.user.id,
						id.data,
						request.signal,
					));
				if (!stream) return new Response(null, { status: 404 });
				return new Response(stream, {
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
					},
				});
			},
		},
	},
});
