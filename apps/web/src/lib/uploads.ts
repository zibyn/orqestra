import { MAX_UPLOAD_BYTES } from "@orqestra/config/shared";
import { m } from "#/paraglide/messages";

/** A failure whose message is for the User. */
export class UploadError extends Error {
	override name = "UploadError";
}

export const tooLarge = (file: File) =>
	m.attachment_too_large({
		name: file.name,
		limit: `${MAX_UPLOAD_BYTES / 1024 / 1024} MB`,
	});

/** Uploads the files one by one to the Conversation (browser only); returns the names they were stored under. */
export async function uploadFiles(conversationId: string, files: File[]) {
	const names: string[] = [];
	for (const file of files) {
		const response = await fetch(
			`/api/conversations/${conversationId}/uploads?name=${encodeURIComponent(file.name)}`,
			{ method: "POST", body: file },
		);
		if (response.status === 413) throw new UploadError(tooLarge(file));
		if (!response.ok)
			throw new UploadError(m.attachment_failed({ name: file.name }));
		names.push(((await response.json()) as { name: string }).name);
	}
	return names;
}
