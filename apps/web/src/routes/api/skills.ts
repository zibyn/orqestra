import { config } from "@orqestra/config/live";
import { SKILL_ZIP_MAX_BYTES } from "@orqestra/config/shared";
import { createFileRoute } from "@tanstack/react-router";
import { readUser } from "#/lib/session";

/** The whole body, or undefined once more than `limit` bytes have come. */
async function readAtMost(body: ReadableStream<Uint8Array>, limit: number) {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		size += chunk.byteLength;
		if (size > limit) return undefined;
		chunks.push(chunk);
	}
	return new Uint8Array(Buffer.concat(chunks));
}

// A Skill's zip, the raw request body, added by an Admin; `?replace=true` once they confirmed adding a version to an existing name.
// Not a server function: that would parse the body before the Admin check could refuse it.
export const Route = createFileRoute("/api/skills")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				const headers = new Headers();
				const user = await readUser(request, (cookie) =>
					headers.append("set-cookie", cookie),
				);
				if (!user) return new Response(null, { status: 401, headers });
				if (!user.admin) return new Response(null, { status: 403, headers });
				const tooLarge = () =>
					Response.json(
						{ errors: { file: { code: "skill_too_large" } } },
						{ status: 413, headers },
					);
				// refused before reading when it says so; the stream is counted anyway
				if (Number(request.headers.get("content-length")) > SKILL_ZIP_MAX_BYTES)
					return tooLarge();
				if (!request.body) return new Response(null, { status: 400, headers });
				const zip = await readAtMost(request.body, SKILL_ZIP_MAX_BYTES);
				if (!zip) return tooLarge();
				const replace = new URL(request.url).searchParams.get("replace");
				return Response.json(
					await config.skills.upload(zip, replace === "true"),
					{ headers },
				);
			},
		},
	},
});
