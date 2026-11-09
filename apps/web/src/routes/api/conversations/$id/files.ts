import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { conversations } from "#/lib/conversations";
import { readUser } from "#/lib/session";
import { m } from "#/paraglide/messages";

const failures = {
	not_found: [404, m.file_not_found],
	no_file: [404, m.file_not_found],
	gone: [410, m.file_sandbox_gone],
	unavailable: [503, m.file_unavailable],
} as const;

// A file the Agent attached, read from the Conversation's Sandbox as it streams: Orqestra keeps no copy
export const Route = createFileRoute("/api/conversations/$id/files")({
	server: {
		handlers: {
			GET: async ({ request, params }) => {
				// the file may change in the Sandbox, and is the User's alone
				const headers = new Headers({ "cache-control": "private, no-store" });
				const user = await readUser(request, (cookie) =>
					headers.append("set-cookie", cookie),
				);
				if (!user) return new Response(null, { status: 401, headers });
				const id = z.uuid().safeParse(params.id);
				const path = new URL(request.url).searchParams.get("path");
				const got =
					id.success && path
						? await conversations.openFile(
								user.id,
								id.data,
								path,
								request.signal,
							)
						: { error: "not_found" as const };
				if ("error" in got) {
					// opened in a tab of its own, so the User reads why
					const [status, message] = failures[got.error];
					headers.set("content-type", "text/plain; charset=utf-8");
					return new Response(message(), { status, headers });
				}
				const { name, size, body } = got.file;
				headers.set("content-type", "application/octet-stream");
				headers.set("x-content-type-options", "nosniff");
				headers.set(
					"content-disposition",
					`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
				);
				if (size !== undefined) headers.set("content-length", String(size));
				return new Response(body, { headers });
			},
		},
	},
});
