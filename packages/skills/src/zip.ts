import { inflateRawSync } from "node:zlib";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillError, SkillFile } from "./shared.ts";

// A Skill uploaded as a zip, checked against the Agent Skills standard (agentskills.io) and Orqestra's limits.

export const SKILL_MAX_BYTES = 10 * 1024 * 1024;
export const SKILL_MAX_FILES = 200;

/** A Skill with its files. */
export interface SkillFiles {
	name: string;
	description: string;
	disableModelInvocation: boolean;
	files: SkillFile[];
}

/** lowercase letters, digits and single hyphens between them, at most 64 characters */
export const skillName = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

type Fail = { error: SkillError };

/** Reads the zip's central directory; stored and deflated entries only, no zip64. */
function unzip(bytes: Uint8Array): SkillFile[] | Fail {
	const invalid = { error: { code: "skill_zip_invalid" as const } };
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	// the end record sits in the last 22 bytes plus a comment of up to 64 KiB
	let end = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
		if (buf.readUInt32LE(i) === 0x06054b50) {
			end = i;
			break;
		}
	if (end < 0) return invalid;
	const count = buf.readUInt16LE(end + 10);
	let at = buf.readUInt32LE(end + 16);
	const raw: {
		path: string;
		method: number;
		size: number;
		offset: number;
		compressed: number;
		mode: number;
	}[] = [];
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50)
			return invalid;
		const nameLength = buf.readUInt16LE(at + 28);
		const entry = {
			method: buf.readUInt16LE(at + 10),
			compressed: buf.readUInt32LE(at + 20),
			size: buf.readUInt32LE(at + 24),
			// unix modes sit in the high half of the external attributes when made on unix
			mode: buf.readUInt8(at + 5) === 3 ? buf.readUInt32LE(at + 38) >>> 16 : 0,
			offset: buf.readUInt32LE(at + 42),
			path: buf.toString("utf8", at + 46, at + 46 + nameLength),
		};
		at +=
			46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
		if (entry.path.endsWith("/") || ignored(entry.path)) continue;
		if (!safePath(entry.path))
			return { error: { code: "skill_path_unsafe", path: entry.path } };
		if ((entry.mode & S_IFMT) === S_IFLNK)
			return { error: { code: "skill_symlink", path: entry.path } };
		total += entry.size;
		if (raw.length >= SKILL_MAX_FILES)
			return { error: { code: "skill_too_many_files" } };
		if (total > SKILL_MAX_BYTES) return { error: { code: "skill_too_large" } };
		raw.push(entry);
	}
	const entries: SkillFile[] = [];
	for (const e of raw) {
		if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50)
			return invalid;
		const start =
			e.offset +
			30 +
			buf.readUInt16LE(e.offset + 26) +
			buf.readUInt16LE(e.offset + 28);
		const data = buf.subarray(start, start + e.compressed);
		let content: Buffer;
		try {
			if (e.method === 0) content = Buffer.from(data);
			else if (e.method === 8)
				// the declared size may lie: never inflate past it
				content = inflateRawSync(data, {
					maxOutputLength: Math.max(e.size, 1),
				});
			else return invalid;
		} catch {
			return invalid;
		}
		if (content.length !== e.size) return invalid;
		entries.push({ path: e.path, content: new Uint8Array(content) });
	}
	return entries;
}

// macOS Finder adds these to zips it makes
const ignored = (path: string) =>
	path.startsWith("__MACOSX/") || path.split("/").at(-1) === ".DS_Store";

const safePath = (path: string) =>
	!path.includes("\\") &&
	!path.startsWith("/") &&
	!/^[a-zA-Z]:/.test(path) &&
	path.split("/").every((s) => s !== ".." && s !== "." && s !== "");

/** The Skill in an uploaded zip, or why it is refused. */
export function parseSkillZip(bytes: Uint8Array): { skill: SkillFiles } | Fail {
	const entries = unzip(bytes);
	if ("error" in entries) return entries;
	const tops = new Set(entries.map((e) => e.path.split("/")[0]));
	const rooted = entries.some((e) => e.path === "SKILL.md");
	const [only] = tops;
	const folder =
		!rooted &&
		tops.size === 1 &&
		entries.some((e) => e.path === `${only}/SKILL.md`)
			? only
			: undefined;
	if (!rooted && !folder) return { error: { code: "skill_md_missing" } };
	const files = entries.map((e) => ({
		path: folder ? e.path.slice(folder.length + 1) : e.path,
		content: e.content,
	}));
	return checkSkill(files, folder);
}

/** Checks a Skill's files against the standard and the limits; `folder` is the name it must carry, when there is one. */
export function checkSkill(
	files: SkillFile[],
	folder?: string,
): { skill: SkillFiles } | Fail {
	const unsafe = files.find((f) => !safePath(f.path));
	if (unsafe)
		return { error: { code: "skill_path_unsafe", path: unsafe.path } };
	const seen = new Set<string>();
	for (const { path } of files) {
		if (seen.has(path))
			return { error: { code: "skill_path_duplicate", path } };
		seen.add(path);
	}
	const nested = files.find((f) => f.path.endsWith("/SKILL.md"));
	if (nested) return { error: { code: "skill_md_nested", path: nested.path } };
	if (files.length > SKILL_MAX_FILES)
		return { error: { code: "skill_too_many_files" } };
	if (files.reduce((n, f) => n + f.content.length, 0) > SKILL_MAX_BYTES)
		return { error: { code: "skill_too_large" } };
	const md = files.find((f) => f.path === "SKILL.md");
	if (!md) return { error: { code: "skill_md_missing" } };
	let frontmatter: Record<string, unknown>;
	try {
		({ frontmatter } = parseFrontmatter(new TextDecoder().decode(md.content)));
	} catch {
		return { error: { code: "skill_frontmatter_invalid" } };
	}
	const { name, description } = frontmatter;
	if (typeof name !== "string" || !skillName.test(name))
		return { error: { code: "skill_name_invalid" } };
	if (folder !== undefined && folder !== name)
		return { error: { code: "skill_name_mismatch", name, folder } };
	if (
		typeof description !== "string" ||
		!description.trim() ||
		[...description].length > 1024
	)
		return { error: { code: "skill_description_invalid" } };
	return {
		skill: {
			name,
			description,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			files,
		},
	};
}
