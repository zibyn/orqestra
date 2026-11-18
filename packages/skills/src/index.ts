import { createHash } from "node:crypto";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Db, Tx } from "@orqestra/db";
import { live } from "@orqestra/db/live";
import { skill, skillFile, skillVersion } from "@orqestra/db/schema";
import type { ObjectStore } from "@orqestra/db/store";
import { and, desc, eq, isNotNull, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { SkillErrors, SkillFile } from "./shared.ts";
import {
	checkSkill,
	parseSkillZip,
	type SkillFiles,
	skillName,
} from "./zip.ts";

/** NOTIFY channel, no payload: a Skill changed, reload them (web -> web and worker). */
const SKILLS_CHANNEL = "skills_changed";

/** A Skill Runs can use; read its files with `skillFiles(db, store, versionId)`. */
export interface SkillInfo {
	/** The current version when the Skills were loaded. */
	versionId: number;
	description: string;
	disableModelInvocation: boolean;
}

/** A SKILL.md's instructions, without its frontmatter. */
export const skillInstructions = (skillMd: string) =>
	stripFrontmatter(skillMd).trim();

export const skillEnabledInput = z.object({
	name: z.string(),
	enabled: z.boolean(),
});
export const skillCurrentInput = z.object({
	name: z.string(),
	versionId: z.number().int(),
});
export const skillCreateInput = z.object({
	name: z.string(),
	description: z.string(),
});
export const skillEditInput = z.object({
	name: z.string(),
	base: z.number().int(),
	// without `text`: kept as it is in version `base`
	files: z.array(z.object({ path: z.string(), text: z.string().optional() })),
});
/** A Skill or version gone since the console loaded it; `field` is the input naming it. */
export class SkillNotFound extends Error {
	constructor(readonly field: "name" | "versionId" | "base") {
		super(field === "name" ? "Skill not found" : "Skill version not found");
	}
}

// A Skill's files are objects named by their bytes under its name (ADR 0017): its versions share those they have in common,
// and deleting the Skill deletes them all
const skillPrefix = (name: string) => `skills/${name}/`;
const objectKey = (name: string, sha256: string) =>
	`${skillPrefix(name)}${sha256}`;
const hash = (content: Uint8Array) =>
	createHash("sha256").update(content).digest("hex");

/**
 * Locks the Skill's name until the transaction ends, whether a Skill has it or not, so its writers put and delete its
 * objects one at a time.
 */
const lockSkill = (tx: Tx, name: string) =>
	tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`skill:${name}`}))`);

/** How long a Skill's puts may hold its lock, and a database connection. */
const PUT_TIMEOUT_MS = 60_000;

/**
 * Puts the files the Skill's objects lack, with the Skill locked. One a file of the Skill already names is never put again,
 * since a put that fails deletes its key.
 */
async function putFiles(
	tx: Tx,
	store: ObjectStore,
	name: string,
	files: { sha256: string; content: Uint8Array }[],
) {
	const stored = await tx
		.selectDistinct({ sha256: skillFile.sha256 })
		.from(skillFile)
		.innerJoin(skillVersion, eq(skillFile.versionId, skillVersion.id))
		.where(and(eq(skillVersion.skillName, name), isNotNull(skillFile.sha256)));
	const known = new Set(stored.map((f) => f.sha256));
	const missing = new Map(
		files.filter((f) => !known.has(f.sha256)).map((f) => [f.sha256, f]),
	);
	const signal = AbortSignal.timeout(PUT_TIMEOUT_MS);
	await Promise.all(
		[...missing.values()].map((f) =>
			store.put(
				objectKey(name, f.sha256),
				new Response(f.content).body as ReadableStream<Uint8Array>,
				{ signal },
			),
		),
	);
}

/** A version's files, paths relative to the Skill's folder, or only the one at `path`; for Runs, by the `versionId` of `current()`. */
export async function skillFiles(
	db: Db,
	store: ObjectStore,
	versionId: number,
	path?: string,
): Promise<SkillFile[]> {
	const rows = await db
		.select({
			path: skillFile.path,
			sha256: skillFile.sha256,
			// only a file not moved yet, as one an api of the release before saves while this one starts (ADR 0017)
			content:
				sql<Uint8Array | null>`case when ${skillFile.sha256} is null then ${skillFile.content} end`.mapWith(
					skillFile.content,
				),
			name: skillVersion.skillName,
		})
		.from(skillFile)
		.innerJoin(skillVersion, eq(skillFile.versionId, skillVersion.id))
		.where(
			and(
				eq(skillFile.versionId, versionId),
				path === undefined ? undefined : eq(skillFile.path, path),
			),
		)
		.orderBy(skillFile.path);
	return Promise.all(
		rows.map(async ({ path, sha256, content, name }) => {
			if (content) return { path, content };
			// none only when the Skill was deleted since its files were listed
			const object = sha256 && (await store.get(objectKey(name, sha256)));
			if (!object)
				throw new Error(`Skill file ${name}/${path} is not in object storage`);
			return {
				path,
				content: new Uint8Array(await new Response(object.body).arrayBuffer()),
			};
		}),
	);
}

/**
 * Moves the content of the files from before ADR 0017 into object storage, a version at a time, recording each one's
 * sha256 and size. The api and worker run it on starting: run again, after an interruption or by both at once, it moves
 * only what is left. Resolves to how many files it moved.
 */
export async function backfillSkillFiles(db: Db, store: ObjectStore) {
	let moved = 0;
	for (;;) {
		const [next] = await db
			.select({ versionId: skillFile.versionId, name: skillVersion.skillName })
			.from(skillFile)
			.innerJoin(skillVersion, eq(skillFile.versionId, skillVersion.id))
			.where(isNull(skillFile.sha256))
			.orderBy(skillFile.versionId)
			.limit(1);
		if (!next) return moved;
		moved += await db.transaction(async (tx) => {
			await lockSkill(tx, next.name);
			// read under the lock: another process may have moved them meanwhile
			const left = await tx
				.select({ path: skillFile.path, content: skillFile.content })
				.from(skillFile)
				.where(
					and(
						eq(skillFile.versionId, next.versionId),
						isNull(skillFile.sha256),
					),
				);
			const files = left.map(({ path, content }) => {
				if (!content) throw new Error(`Skill file ${path} has no content`);
				return { path, content, sha256: hash(content) };
			});
			await putFiles(tx, store, next.name, files);
			for (const f of files)
				await tx
					.update(skillFile)
					.set({ sha256: f.sha256, size: f.content.length })
					.where(
						and(
							eq(skillFile.versionId, next.versionId),
							eq(skillFile.path, f.path),
						),
					);
			return files.length;
		});
	}
}

/** Enabled Skills with their current version, by name; the others are unavailable. */
async function loadSkills(db: Db) {
	const rows = await db
		.select({
			name: skill.name,
			enabled: skill.enabled,
			versionId: skillVersion.id,
			description: skillVersion.description,
			disableModelInvocation: skillVersion.disableModelInvocation,
		})
		.from(skill)
		.innerJoin(skillVersion, eq(skill.currentVersionId, skillVersion.id))
		.orderBy(skill.name);
	const skills: Record<string, SkillInfo> = {};
	for (const { name, enabled, ...info } of rows)
		if (enabled) skills[name] = info;
	return skills;
}

/** Adds the Skill as its new current version, adding the Skill itself when it is new; one that exists needs `replace`. */
async function addVersion(
	tx: Tx,
	store: ObjectStore,
	{ name, description, disableModelInvocation, files }: SkillFiles,
	replace: boolean,
): Promise<SkillErrors> {
	const inserted = await tx
		.insert(skill)
		.values({ name })
		.onConflictDoNothing()
		.returning({ name: skill.name });
	if (!inserted.length && !replace) return { name: { code: "skill_exists" } };
	// two saves cannot take the same number, nor write the Skill's objects at once
	await lockSkill(tx, name);
	const hashed = files.map((f) => ({ ...f, sha256: hash(f.content) }));
	// before the version is committed, so no version names a file not yet stored
	await putFiles(tx, store, name, hashed);
	const [{ last }] = await tx
		.select({ last: max(skillVersion.number) })
		.from(skillVersion)
		.where(eq(skillVersion.skillName, name));
	const [version] = await tx
		.insert(skillVersion)
		.values({
			skillName: name,
			number: (last ?? 0) + 1,
			description,
			disableModelInvocation,
		})
		.returning({ id: skillVersion.id });
	await tx.insert(skillFile).values(
		hashed.map((f) => ({
			versionId: version.id,
			path: f.path,
			sha256: f.sha256,
			size: f.content.length,
		})),
	);
	await tx
		.update(skill)
		.set({ currentVersionId: version.id })
		.where(eq(skill.name, name));
	return {};
}

function asText(content: Uint8Array) {
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
		return text.includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}

/**
 * The Skills: `current()` for Runs, and what Admins edit in /console. Loaded on the first `current()`;
 * every write reloads it here and in every other process once committed. Callers check that the User is an Admin.
 */
export function createSkills(db: Db, store: ObjectStore) {
	const skills = live(db, {
		channel: SKILLS_CHANNEL,
		load: () => loadSkills(db),
	});
	const { write } = skills;
	return {
		...skills,

		/** Every Skill with its versions, newest first; `description` is the current version's. */
		async list() {
			const [skills, versions] = await Promise.all([
				db.select().from(skill).orderBy(skill.name),
				db
					.select({
						id: skillVersion.id,
						skillName: skillVersion.skillName,
						number: skillVersion.number,
						description: skillVersion.description,
						createdAt: skillVersion.createdAt,
					})
					.from(skillVersion)
					.orderBy(desc(skillVersion.number)),
			]);
			return skills.map((s) => {
				const own = versions.filter((v) => v.skillName === s.name);
				return {
					name: s.name,
					enabled: s.enabled,
					currentVersionId: s.currentVersionId,
					description:
						own.find((v) => v.id === s.currentVersionId)?.description ?? "",
					versions: own.map(({ skillName: _, ...v }) => v),
				};
			});
		},

		/** Adds the zip as a new current version; one whose name exists needs `replace`. `name` is set once the zip is valid. */
		async upload(
			zip: Uint8Array,
			replace: boolean,
		): Promise<{ errors: SkillErrors; name?: string }> {
			const parsed = parseSkillZip(zip);
			if ("error" in parsed) return { errors: { file: parsed.error } };
			const { name } = parsed.skill;
			const errors = await write((tx) =>
				addVersion(tx, store, parsed.skill, replace),
			);
			return { errors, name };
		},

		/** A new Skill written in the console: its first version is a SKILL.md with only the frontmatter. */
		async create(
			name: string,
			description: string,
		): Promise<{ errors: SkillErrors }> {
			// checked before it goes into the YAML, where a line break could add keys
			if (!skillName.test(name))
				return { errors: { name: { code: "skill_name_invalid" } } };
			// a JSON string is a YAML double-quoted scalar
			const md = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
			const checked = checkSkill(
				[{ path: "SKILL.md", content: new TextEncoder().encode(md) }],
				name,
			);
			if ("error" in checked)
				return {
					errors: {
						[checked.error.code === "skill_description_invalid"
							? "description"
							: "name"]: checked.error,
					},
				};
			return {
				errors: await write((tx) =>
					addVersion(tx, store, checked.skill, false),
				),
			};
		},

		/** A version's files for the console editor: `text` only for those that are UTF-8 text, the rest can only be kept or dropped. */
		files: async (versionId: number) =>
			(await skillFiles(db, store, versionId)).map(({ path, content }) => {
				const text = asText(content);
				return {
					path,
					size: content.length,
					...(text !== undefined && { text }),
				};
			}),

		/** Saves the Skill's files as a new current version: those with `text` as written, those without kept as they are in version `base`. */
		async edit(
			name: string,
			base: number,
			files: { path: string; text?: string }[],
		): Promise<{ errors: SkillErrors }> {
			const [version] = await db
				.select({ id: skillVersion.id })
				.from(skillVersion)
				.where(
					and(eq(skillVersion.id, base), eq(skillVersion.skillName, name)),
				);
			if (!version) throw new SkillNotFound("base");
			const old = new Map(
				(await skillFiles(db, store, base)).map((f) => [f.path, f.content]),
			);
			const contents: SkillFile[] = [];
			for (const { path, text } of files) {
				const kept = old.get(path);
				// the console shows a binary file without its bytes, so text for it would replace it unseen
				if (text !== undefined && kept && asText(kept) === undefined)
					return { errors: { file: { code: "skill_file_binary", path } } };
				const content =
					text === undefined ? kept : new TextEncoder().encode(text);
				if (!content) return { errors: { file: { code: "not_found" } } };
				contents.push({ path, content });
			}
			const checked = checkSkill(contents, name);
			if ("error" in checked) return { errors: { file: checked.error } };
			return {
				errors: await write((tx) => addVersion(tx, store, checked.skill, true)),
			};
		},

		async setEnabled(name: string, enabled: boolean) {
			const updated = await write((tx) =>
				tx
					.update(skill)
					.set({ enabled })
					.where(eq(skill.name, name))
					.returning({ name: skill.name }),
			);
			if (!updated.length) throw new SkillNotFound("name");
		},

		/** Agents use this version from their next Run on; it must be one of the Skill's. */
		async setCurrent(name: string, versionId: number) {
			const updated = await write((tx) =>
				tx
					.update(skill)
					.set({ currentVersionId: versionId })
					.where(
						and(
							eq(skill.name, name),
							sql`exists (select 1 from ${skillVersion} where ${skillVersion.id} = ${versionId} and ${skillVersion.skillName} = ${name})`,
						),
					)
					.returning({ name: skill.name }),
			);
			if (!updated.length) throw new SkillNotFound("versionId");
		},

		/** Also deletes its versions and their files; Agent Definitions that name it are left to their owner. */
		async delete(name: string) {
			await write(async (tx) => {
				await lockSkill(tx, name);
				await tx.delete(skill).where(eq(skill.name, name));
			});
			// once no version names them, holding the name so no file is put meanwhile, and only while no Skill has it
			// again. Those storage does not delete are left, named by nothing, until the name is deleted again
			await db
				.transaction(async (tx) => {
					await lockSkill(tx, name);
					const [again] = await tx
						.select({ name: skill.name })
						.from(skill)
						.where(eq(skill.name, name));
					if (!again) await store.deletePrefix(skillPrefix(name));
				})
				.catch((error) =>
					console.error(`Skill ${name}'s files are left in storage`, error),
				);
		},
	};
}

export type Skills = ReturnType<typeof createSkills>;
