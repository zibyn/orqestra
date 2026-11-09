import { MAX_UPLOAD_BYTES } from "@orqestra/config/shared";
import { ConversationError, UploadTooLarge } from "@orqestra/conversations";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { conversations } from "#/lib/conversations";
import { readUser } from "#/lib/session";

// One attachment, the raw request body, streamed into the Conversation's Sandbox; `?name=` is the file's name.
// Answers {name, path} as stored (renamed when taken); 413 past MAX_UPLOAD_BYTES.
export const Route = createFileRoute("/api/conversations/$id/uploads")({
	server: {
		handlers: {
			POST: async ({ request, params }) => {
				const headers = new Headers();
				const user = await readUser(request, (cookie) =>
					headers.append("set-cookie", cookie),
				);
				if (!user) return new Response(null, { status: 401, headers });
				const id = z.uuid().safeParse(params.id);
				if (!id.success) return new Response(null, { status: 404, headers });
				// refused before reading when it says so; the stream is counted anyway
				if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES)
					return new Response(null, { status: 413, headers });
				if (!request.body) return new Response(null, { status: 400, headers });
				const name = new URL(request.url).searchParams.get("name") ?? "";
				try {
					const file = await conversations.upload(
						user.id,
						id.data,
						name,
						request.body,
						{ signal: request.signal },
					);
					if (!file) return new Response(null, { status: 404, headers });
					return Response.json(file, { headers });
				} catch (error) {
					if (error instanceof UploadTooLarge)
						return new Response(null, { status: 413, headers });
					if (error instanceof ConversationError)
						return new Response(error.message, { status: 409, headers });
					console.error("Upload into the Sandbox failed:", error);
					return new Response(null, { status: 502, headers });
				}
			},
		},
	},
});
