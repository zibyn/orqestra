import {
	ConversationError,
	type Conversations,
	UploadTooLarge,
} from "@orqestra/conversations";
import { MAX_UPLOAD_BYTES } from "@orqestra/conversations/shared";
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

/** An Attachment of the Conversation, `?name=`, streamed from object storage. */
export async function download(
	conversations: Conversations,
	userId: string,
	id: string,
	request: Request,
) {
	const name = new URL(request.url).searchParams.get("name");
	const got =
		z.uuid().safeParse(id).success && name
			? await conversations.openFile(userId, id, name)
			: { error: "not_found" as const };
	if ("error" in got) return error(404, "file", "not_found");
	const { size, body } = got.file;
	const headers = new Headers({
		"content-type": "application/octet-stream",
		"x-content-type-options": "nosniff",
		"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(got.file.name)}`,
		"content-length": String(size),
	});
	return new Response(body, { headers });
}
