import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { conversations } from "#/lib/conversations";
import { readUser } from "#/lib/session";

// SSE stream of a Conversation's live events; see conversations.subscribe
export const Route = createFileRoute("/api/conversations/$id/events")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				const headers = new Headers();
				const user = await readUser(request, (cookie) =>
					headers.append("set-cookie", cookie),
				);
				if (!user) return new Response(null, { status: 401, headers });
				const id = z.uuid().safeParse(params.id);
				const stream =
					id.success &&
					(await conversations.subscribe(user.id, id.data, request.signal));
				if (!stream) return new Response(null, { status: 404, headers });
				headers.set("content-type", "text/event-stream");
				headers.set("cache-control", "no-cache");
				return new Response(stream, { headers });
			},
		},
	},
});
