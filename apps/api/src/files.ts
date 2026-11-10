import { MAX_UPLOAD_BYTES } from "@orqestra/config/shared";
import {
	ConversationError,
	type Conversations,
	UploadTooLarge,
} from "@orqestra/conversations";
import { z } from "zod";

const error = (status: number, field: string, code: string) =>
	Response.json({ errors: { [field]: { code } } }, { status });

/**
 * One attachment, the raw request body, streamed into object storage; `?name=` is the file's name.
 * Answers {name} as stored (renamed when taken); 413 past MAX_UPLOAD_BYTES.
 */
export async function upload(
	conversations: Conversations,
	userId: string,
	id: string,
	request: Request,
) {
	if (!z.uuid().safeParse(id).success)
		return error(404, "conversation", "not_found");
	// refused before reading when it says so; the stream is counted anyway
	if (Number(request.headers.get("content-length")) > MAX_UPLOAD_BYTES)
		return error(413, "file", "too_large");
	if (!request.body) return error(400, "file", "required");
	const name = new URL(request.url).searchParams.get("name") ?? "";
	try {
		const file = await conversations.upload(userId, id, name, request.body, {
			signal: request.signal,
		});
		return file ?? error(404, "conversation", "not_found");
	} catch (e) {
		if (e instanceof UploadTooLarge) return error(413, "file", "too_large");
		// the only one: the Agent is offline
		if (e instanceof ConversationError) return error(409, e.field, e.code);
		console.error("Upload into object storage failed:", e);
		return error(502, "file", "storage_failed");
	}
}

const failures = {
	not_found: 404,
	no_file: 404,
	gone: 410,
	unavailable: 503,
} as const;

/** A file the Agent attached, read from the Conversation's Sandbox as it streams: Orqestra keeps no copy. */
export async function download(
	conversations: Conversations,
	userId: string,
	id: string,
	request: Request,
) {
	const path = new URL(request.url).searchParams.get("path");
	const got =
		z.uuid().safeParse(id).success && path
			? await conversations.openFile(userId, id, path, request.signal)
			: { error: "not_found" as const };
	if ("error" in got)
		return error(
			failures[got.error],
			"file",
			got.error === "no_file" ? "not_found" : got.error,
		);
	const { name, size, body } = got.file;
	const headers = new Headers({
		"content-type": "application/octet-stream",
		"x-content-type-options": "nosniff",
		"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
	});
	if (size !== undefined) headers.set("content-length", String(size));
	return new Response(body, { headers });
}
