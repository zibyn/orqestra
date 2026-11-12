import { MAX_UPLOAD_BYTES } from "@orqestra/config";
import { db } from "@orqestra/db";
import { attachment } from "@orqestra/db/schema";
import type {
	ObjectStore,
	orrery as orreryClient,
	SandboxProvider,
} from "@orqestra/tools";
import { and, eq, inArray, lt } from "drizzle-orm";
import { ConversationError } from "./errors.ts";
import { ensureSandbox } from "./sandbox.ts";

/** Where attachments go in the Sandbox, relative to /workspace. */
const UPLOADS = "uploads";

export class UploadTooLarge extends Error {
	override name = "UploadTooLarge";
	constructor() {
		super(`The file is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
	}
}

/** The path the Agent reads an attachment at. */
export const uploadPath = (name: string) => `/workspace/${UPLOADS}/${name}`;

/** `name` as its stem and extension (with its dot); a leading dot starts no extension. */
function splitName(name: string) {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/**
 * A file name safe to use as one path segment in the Sandbox: the last segment of what the browser sent,
 * without control characters or leading dots (no `..`, no hidden files), at most 200 bytes, keeping the extension.
 */
export function safeFileName(name: string) {
	let clean = (name.split(/[\\/]/).at(-1) ?? "")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.trim()
		.replace(/^\.+/, "");
	if (!clean) return "file";
	let [rest, ext] = splitName(clean);
	if (ext.length > 16) [rest, ext] = [clean, ""];
	let stem = [...rest];
	while (Buffer.byteLength(stem.join("") + ext) > 200) stem = stem.slice(0, -1);
	clean = stem.join("") + ext;
	return clean;
}

/** `name`, or `stem (n).ext` with the first n not taken. */
function freeName(name: string, taken: Set<string>) {
	const [stem, ext] = splitName(name);
	let free = name;
	for (let n = 1; taken.has(free); n++) free = `${stem} (${n})${ext}`;
	return free;
}

/**
 * Streams one file into object storage, refusing it once it passes MAX_UPLOAD_BYTES, and records it as an unsent
 * Attachment of the Conversation under a free name. A refused or broken file leaves nothing.
 */
export async function storeAttachment(
	store: ObjectStore,
	conv: { id: string; rootId: string },
	name: string,
	body: ReadableStream<Uint8Array>,
	{ signal }: { signal?: AbortSignal } = {},
) {
	// under the top-level Conversation's id, so deleting it deletes its Subagents' objects too
	const key = `${conv.rootId}/${conv.id}/${crypto.randomUUID()}`;
	let size = 0;
	try {
		await store.put(
			key,
			body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						size += chunk.byteLength;
						if (size > MAX_UPLOAD_BYTES) controller.error(new UploadTooLarge());
						else controller.enqueue(chunk);
					},
				}),
			),
			{ signal },
		);
	} catch (error) {
		// a store may report a failed body as an error of its own
		throw size > MAX_UPLOAD_BYTES ? new UploadTooLarge() : error;
	}
	try {
		const wanted = safeFileName(name);
		// the unique (conversation, name) decides between Attachments of one name at once: the loser picks again
		for (;;) {
			const taken = await db
				.select({ name: attachment.name })
				.from(attachment)
				.where(eq(attachment.conversationId, conv.id));
			const [row] = await db
				.insert(attachment)
				.values({
					conversationId: conv.id,
					name: freeName(wanted, new Set(taken.map((t) => t.name))),
					size,
					key,
				})
				.onConflictDoNothing()
				.returning({ name: attachment.name, size: attachment.size });
			if (row) return row;
		}
	} catch (error) {
		await store.deletePrefix(key);
		throw error;
	}
}

/** Deletes the objects under `prefixes` once their rows are gone; one storage does not delete is logged and left there. */
export async function deleteObjects(store: ObjectStore, prefixes: string[]) {
	await Promise.all(
		prefixes.map((prefix) =>
			store
				.deletePrefix(prefix)
				.catch((error) =>
					console.error(`Attachments ${prefix} are left in storage`, error),
				),
		),
	);
}

/** Deletes the Attachments not sent with a message for a day before `now`, rows first, then their objects. */
export async function sweepUnsentAttachments(
	store: ObjectStore,
	now = new Date(),
) {
	const swept = await db
		.delete(attachment)
		.where(
			and(
				eq(attachment.sent, false),
				lt(attachment.createdAt, new Date(now.getTime() - 24 * 3600_000)),
			),
		)
		.returning({ key: attachment.key });
	await deleteObjects(
		store,
		swept.map((a) => a.key),
	);
}

/**
 * Sends the Conversation's Attachments `names` (as `upload` returned them) with a user message: marks them sent and,
 * with a Sandbox Provider, copies them into its Sandbox at /workspace/uploads/<name>. Returns the text telling the Agent
 * about them and the list the User sees, or undefined with none. Throws ConversationError for a name that is not one
 * of its Attachments, and whatever the copy fails with, leaving those that were unsent unsent.
 */
export async function sendAttachments(
	{ store, orrery }: { store: ObjectStore; orrery: typeof orreryClient },
	conversationId: string | undefined,
	names: string[],
	{
		sandboxProvider: provider,
		parse,
	}: { sandboxProvider?: SandboxProvider; parse: boolean },
) {
	names = [...new Set(names)];
	if (!names.length) return undefined;
	const notAttachment = new ConversationError(
		"Not an attachment's name",
		"attachments",
		"not_attachment",
	);
	if (!conversationId) throw notAttachment;
	// marked sent before they are copied, so the sweep cannot delete one on its way into the Sandbox
	const rows = await db.transaction(async (tx) => {
		const found = await tx
			.select()
			.from(attachment)
			.where(
				and(
					eq(attachment.conversationId, conversationId),
					inArray(attachment.name, names),
				),
			)
			.for("update");
		// a name never stored, swept, or unsafe (stored names are safe) is refused
		if (found.length !== names.length) throw notAttachment;
		await tx
			.update(attachment)
			.set({ sent: true })
			.where(
				inArray(
					attachment.id,
					found.map((r) => r.id),
				),
			);
		return found;
	});
	const attachments = names.map((name) => ({ name, path: uploadPath(name) }));
	if (!provider)
		return {
			text: `\n\nAttached files${
				parse ? ", which the Parse tool reads by name" : ""
			}:\n${names.map((name) => `- ${name}`).join("\n")}`,
			attachments,
		};
	// orrery's 65-second request timeout is too short to copy 50 MB
	const client = orrery({ ...provider, timeoutMs: 10 * 60_000 });
	try {
		const sandbox = await ensureSandbox(conversationId, client, provider);
		for (const { name, key } of rows) {
			const object = await store.get(key);
			if (!object)
				throw new Error(`The Attachment ${name} is missing from storage`);
			await client.writeFile(sandbox.id, `${UPLOADS}/${name}`, object.body);
		}
	} catch (error) {
		// not sent after all: those that were unsent are the sweep's again
		await db
			.update(attachment)
			.set({ sent: false })
			.where(
				inArray(
					attachment.id,
					rows.filter((r) => !r.sent).map((r) => r.id),
				),
			);
		throw error;
	}
	return {
		text: `\n\nAttached files, in your Sandbox:\n${attachments.map((a) => `- ${a.path}`).join("\n")}`,
		attachments,
	};
}
