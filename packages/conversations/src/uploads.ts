import { MAX_UPLOAD_BYTES } from "@orqestra/config";
import { type Orrery, OrreryError } from "@orqestra/tools";

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
	const dot = clean.lastIndexOf(".");
	const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
	let stem = [...clean.slice(0, clean.length - ext.length)];
	while (Buffer.byteLength(stem.join("") + ext) > 200) stem = stem.slice(0, -1);
	clean = stem.join("") + ext;
	return clean;
}

/** `name`, or `stem (n).ext` with the first n not taken. */
function freeName(name: string, taken: Set<string>) {
	const dot = name.lastIndexOf(".");
	const [stem, ext] =
		dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	let free = name;
	for (let n = 1; taken.has(free); n++) free = `${stem} (${n})${ext}`;
	return free;
}

/** Passes `body` through, erroring once more than the limit has come. */
function limited(body: ReadableStream<Uint8Array>, over: () => void) {
	let size = 0;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				size += chunk.byteLength;
				if (size > MAX_UPLOAD_BYTES) {
					over();
					controller.error(new UploadTooLarge());
				} else controller.enqueue(chunk);
			},
		}),
	);
}

/**
 * Streams one file into the ready Sandbox's uploads folder under a free name, refusing it once it passes
 * MAX_UPLOAD_BYTES; orrery writes to a temporary file, so a refused or broken upload leaves nothing.
 */
export async function writeUpload(
	client: Orrery,
	sandbox: string,
	name: string,
	body: ReadableStream<Uint8Array>,
	{ signal }: { signal?: AbortSignal } = {},
) {
	const taken = await client.listFiles(sandbox, UPLOADS, { signal }).then(
		(items) => new Set(items.map((i) => i.name)),
		(error) => {
			if (error instanceof OrreryError && error.code === "not_found")
				return new Set<string>();
			throw error;
		},
	);
	// shortcut: two uploads of one name at once may pick the same free name, the later winning; needs an exclusive create in orrery
	const free = freeName(safeFileName(name), taken);
	let tooLarge = false;
	try {
		await client.writeFile(
			sandbox,
			`${UPLOADS}/${free}`,
			limited(body, () => {
				tooLarge = true;
			}),
			{ signal },
		);
	} catch (error) {
		// fetch reports a failed body as its own TypeError
		throw tooLarge ? new UploadTooLarge() : error;
	}
	return { name: free, path: uploadPath(free) };
}
