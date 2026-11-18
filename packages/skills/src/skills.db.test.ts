import { createHash } from "node:crypto";
import type { ObjectStore } from "@orqestra/db/store";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SkillFile } from "./shared.ts";

// Writes through the interface against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
const { drizzle } = await import("drizzle-orm/node-postgres");
const { sql } = await import("drizzle-orm");
const schema = await import("@orqestra/db/schema");
const { memoryStore } = await import("@orqestra/db/store");
const {
	backfillSkillFiles,
	createSkills,
	skillFiles: filesOf,
} = await import("./index.ts");
const { zip } = await import("./test-zip.ts");
const db = drizzle(url ?? "", { schema });
const { store: memory, objects } = memoryStore();
/** Puts fail once `puts.left` reaches 0, deleting the key as s3Store does after a failed multipart upload. */
const puts = { left: Number.POSITIVE_INFINITY };
const store: ObjectStore = {
	...memory,
	put: async (key, body) => {
		if (puts.left-- <= 0) {
			objects.delete(key);
			throw new Error("object storage is down");
		}
		await memory.put(key, body);
	},
};
const skills = createSkills(db, store);
const skillFiles = (versionId: number) => filesOf(db, store, versionId);
const sha256 = (s: string | Uint8Array) =>
	createHash("sha256").update(s).digest("hex");

describe.skipIf(!url)("@orqestra/skills writes (Postgres)", () => {
	const reset = () => db.execute(sql`truncate skill cascade`);
	beforeEach(async () => {
		await reset();
		objects.clear();
		puts.left = Number.POSITIVE_INFINITY;
	});
	afterAll(async () => {
		await reset();
		await skills.close();
		await db.$client.end();
	});

	const skillZip = (name: string, description: string, extra = {}) =>
		zip([
			{
				path: `${name}/SKILL.md`,
				content: `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
			},
			...Object.entries(extra).map(([path, content]) => ({
				path: `${name}/${path}`,
				content: content as string,
			})),
		]);
	const text = (files: SkillFile[]) =>
		Object.fromEntries(
			files.map((f) => [f.path, new TextDecoder().decode(f.content)]),
		);
	const currentFiles = async (name: string) => {
		const skill = (await skills.current())[name];
		return skill && text(await skillFiles(skill.versionId));
	};

	it("refuses an invalid zip with the reason", async () => {
		expect(await skills.upload(zip([]), false)).toEqual({
			errors: { file: { code: "skill_md_missing" } },
		});
		expect(await skills.list()).toEqual([]);
	});

	it("makes an uploaded Skill available to Runs with its files", async () => {
		expect(
			await skills.upload(
				skillZip("pdf", "Fills PDFs", { "scripts/a.py": "print(1)" }),
				false,
			),
		).toEqual({ errors: {}, name: "pdf" });
		expect((await skills.current()).pdf).toMatchObject({
			description: "Fills PDFs",
			disableModelInvocation: false,
		});
		expect(await currentFiles("pdf")).toEqual({
			"SKILL.md": "---\nname: pdf\ndescription: Fills PDFs\n---\nBody\n",
			"scripts/a.py": "print(1)",
		}); // or only the one a User's /skill: message needs
		const { versionId } = (await skills.current()).pdf;
		expect(
			(await filesOf(db, store, versionId, "SKILL.md")).map((f) => f.path),
		).toEqual(["SKILL.md"]);
	});

	it("asks before uploading a name that exists, then adds a version", async () => {
		await skills.upload(skillZip("pdf", "v1"), false);
		expect(await skills.upload(skillZip("pdf", "v2"), false)).toEqual({
			errors: { name: { code: "skill_exists" } },
			name: "pdf",
		});
		expect((await skills.current()).pdf.description).toBe("v1");
		await skills.upload(skillZip("pdf", "v2"), true);
		const [listed, ...others] = await skills.list();
		expect(others).toEqual([]);
		expect(listed).toMatchObject({
			name: "pdf",
			description: "v2",
			enabled: true,
		});
		expect(listed.versions.map((v) => [v.number, v.description])).toEqual([
			[2, "v2"],
			[1, "v1"],
		]);
		expect(listed.currentVersionId).toBe(listed.versions[0].id);
	});

	it("rolls back to an earlier version, files included", async () => {
		await skills.upload(skillZip("pdf", "v1", { a: "old" }), false);
		await skills.upload(skillZip("pdf", "v2", { b: "new" }), true);
		const [{ versions }] = await skills.list();
		await skills.setCurrent("pdf", versions[1].id);
		expect((await skills.current()).pdf.description).toBe("v1");
		expect(Object.keys(await currentFiles("pdf"))).toEqual(["SKILL.md", "a"]);
		// another Skill's version is not one of its own
		await skills.upload(skillZip("doc", "d"), false);
		const doc = (await skills.list()).find((s) => s.name === "doc");
		await expect(
			skills.setCurrent("pdf", doc?.versions[0].id ?? 0),
		).rejects.toThrow(/not found/);
	});

	it("creates a Skill with a SKILL.md carrying its name and description", async () => {
		expect(await skills.create("pdf", 'Fills PDFs: "forms"')).toEqual({
			errors: {},
		});
		expect(await currentFiles("pdf")).toEqual({
			"SKILL.md":
				'---\nname: pdf\ndescription: "Fills PDFs: \\"forms\\""\n---\n\n',
		});
		expect((await skills.current()).pdf.description).toBe(
			'Fills PDFs: "forms"',
		);
		expect(await skills.create("pdf", "again")).toEqual({
			errors: { name: { code: "skill_exists" } },
		});
		expect(await skills.create("Bad Name", "d")).toEqual({
			errors: { name: { code: "skill_name_invalid" } },
		});
		expect(await skills.create("doc", " ")).toEqual({
			errors: { description: { code: "skill_description_invalid" } },
		});
		expect((await skills.list()).map((s) => s.name)).toEqual(["pdf"]);
	});

	it("saves edited files as a new version, keeping binary files untouched", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		await skills.upload(
			zip([
				{
					path: "SKILL.md",
					content: "---\nname: pdf\ndescription: v1\n---\n",
				},
				{ path: "scripts/a.py", content: "print(1)" },
				{ path: "assets/logo.png", content: png },
			]),
			false,
		);
		const [{ currentVersionId }] = await skills.list();
		const base = currentVersionId ?? 0;
		expect(await skills.files(base)).toEqual([
			{
				path: "SKILL.md",
				size: 34,
				text: "---\nname: pdf\ndescription: v1\n---\n",
			},
			{ path: "assets/logo.png", size: 6 },
			{ path: "scripts/a.py", size: 8, text: "print(1)" },
		]);
		expect(
			await skills.edit("pdf", base, [
				{ path: "SKILL.md", text: "---\nname: pdf\ndescription: v2\n---\n" },
				{ path: "scripts/b.py", text: "print(2)" },
				{ path: "assets/logo.png" },
			]),
		).toEqual({ errors: {} });
		expect((await skills.current()).pdf.description).toBe("v2");
		const files = await currentFiles("pdf");
		expect(Object.keys(files).sort()).toEqual([
			"SKILL.md",
			"assets/logo.png",
			"scripts/b.py",
		]);
		const version = (await skills.current()).pdf.versionId;
		const logo = (await skillFiles(version)).find(
			(f) => f.path === "assets/logo.png",
		);
		expect(Buffer.from(logo?.content ?? [])).toEqual(png);
		expect((await skills.list())[0].versions).toHaveLength(2);
	});

	it("refuses text for a binary file, and a path given twice", async () => {
		await skills.upload(
			zip([
				{
					path: "SKILL.md",
					content: "---\nname: pdf\ndescription: v1\n---\n",
				},
				{ path: "logo.png", content: Buffer.from([0x89, 0x00, 0xff]) },
			]),
			false,
		);
		const [{ currentVersionId }] = await skills.list();
		const base = currentVersionId ?? 0;
		const md = {
			path: "SKILL.md",
			text: "---\nname: pdf\ndescription: v2\n---\n",
		};
		expect(
			await skills.edit("pdf", base, [md, { path: "logo.png", text: "x" }]),
		).toEqual({
			errors: { file: { code: "skill_file_binary", path: "logo.png" } },
		});
		expect(
			await skills.edit("pdf", base, [
				md,
				{ path: "a.md", text: "1" },
				{ path: "a.md", text: "2" },
			]),
		).toEqual({
			errors: { file: { code: "skill_path_duplicate", path: "a.md" } },
		});
		expect((await skills.list())[0].versions).toHaveLength(1);
	});

	it("refuses an edit the standard or the Skill's name does not allow", async () => {
		await skills.create("pdf", "d");
		const [{ currentVersionId }] = await skills.list();
		const base = currentVersionId ?? 0;
		const md = (name: string) => ({
			path: "SKILL.md",
			text: `---\nname: ${name}\ndescription: d\n---\n`,
		});
		expect(await skills.edit("pdf", base, [md("doc")])).toEqual({
			errors: {
				file: { code: "skill_name_mismatch", name: "doc", folder: "pdf" },
			},
		});
		expect(
			await skills.edit("pdf", base, [md("pdf"), { path: "../x", text: "" }]),
		).toEqual({
			errors: { file: { code: "skill_path_unsafe", path: "../x" } },
		});
		// a kept file must be one of the version's
		expect(
			await skills.edit("pdf", base, [md("pdf"), { path: "gone.png" }]),
		).toEqual({ errors: { file: { code: "not_found" } } });
		await skills.create("doc", "d");
		await expect(skills.edit("doc", base, [md("doc")])).rejects.toThrow(
			/not found/,
		);
		expect((await skills.list())[1].versions).toHaveLength(1);
	});

	it("keeps an upload's files in object storage, under the Skill by their bytes, and only their index in Postgres", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
		const md = "---\nname: pdf\ndescription: d\n---\n";
		await skills.upload(
			zip([
				{ path: "SKILL.md", content: md },
				{ path: "logo.png", content: png },
				// the same bytes twice are one object
				{ path: "copy.png", content: png },
			]),
			false,
		);
		expect(new Map(objects)).toEqual(
			new Map([
				[`skills/pdf/${sha256(md)}`, new TextEncoder().encode(md)],
				[`skills/pdf/${sha256(png)}`, new Uint8Array(png)],
			]),
		);
		const rows = await db
			.select({
				path: schema.skillFile.path,
				sha256: schema.skillFile.sha256,
				size: schema.skillFile.size,
				content: schema.skillFile.content,
			})
			.from(schema.skillFile)
			.orderBy(schema.skillFile.path);
		expect(rows).toEqual([
			{ path: "SKILL.md", sha256: sha256(md), size: md.length, content: null },
			{ path: "copy.png", sha256: sha256(png), size: 6, content: null },
			{ path: "logo.png", sha256: sha256(png), size: 6, content: null },
		]);
	});

	it("shares the files a new version keeps, so a failed save never loses an earlier version's", async () => {
		const png = Buffer.from([0x89, 0x00, 0xff]);
		await skills.upload(
			zip([
				{ path: "SKILL.md", content: "---\nname: pdf\ndescription: v1\n---\n" },
				{ path: "logo.png", content: png },
			]),
			false,
		);
		const v1 = (await skills.current()).pdf.versionId;
		const v2md = "---\nname: pdf\ndescription: v2\n---\n";
		const edit = () =>
			skills.edit("pdf", v1, [
				{ path: "SKILL.md", text: v2md },
				{ path: "logo.png" },
			]);
		// every put fails, as when object storage goes down: only the new SKILL.md was to be put
		puts.left = 0;
		await expect(edit()).rejects.toThrow(/down/);
		expect((await skills.list())[0].versions).toHaveLength(1);
		expect(Buffer.from((await skillFiles(v1))[1].content)).toEqual(png);
		puts.left = Number.POSITIVE_INFINITY;
		expect(await edit()).toEqual({ errors: {} });
		// two SKILL.mds and one logo
		expect(objects.size).toBe(3);
		const v2 = await skillFiles((await skills.current()).pdf.versionId);
		expect(v2.map((f) => [f.path, Buffer.from(f.content)])).toEqual([
			["SKILL.md", Buffer.from(v2md)],
			["logo.png", png],
		]);
	});

	it("deletes a deleted Skill's files, leaving another Skill's with the same bytes, though its name starts the same", async () => {
		await skills.upload(skillZip("pdf", "d", { "a.py": "print(1)" }), false);
		await skills.upload(skillZip("pdf-2", "d", { "a.py": "print(1)" }), false);
		await skills.delete("pdf");
		expect([...objects.keys()].sort()).toEqual(
			[
				`skills/pdf-2/${sha256("print(1)")}`,
				`skills/pdf-2/${sha256("---\nname: pdf-2\ndescription: d\n---\nBody\n")}`,
			].sort(),
		);
		expect(await currentFiles("pdf-2")).toEqual({
			"SKILL.md": "---\nname: pdf-2\ndescription: d\n---\nBody\n",
			"a.py": "print(1)",
		});
		// deleting again, or one that does not exist, deletes nothing else
		await skills.delete("pdf");
		expect(objects.size).toBe(2);
	});

	describe("the backfill of files from before object storage", () => {
		/** A Skill as saved before: its files' bytes in Postgres, without sha256 or size; resolves to its version ids. */
		async function saved(name: string, versions: Record<string, string>[]) {
			await db.insert(schema.skill).values({ name });
			const ids: number[] = [];
			for (const [i, files] of versions.entries()) {
				const [{ id }] = await db
					.insert(schema.skillVersion)
					.values({
						skillName: name,
						number: i + 1,
						description: "d",
						disableModelInvocation: false,
					})
					.returning({ id: schema.skillVersion.id });
				await db.insert(schema.skillFile).values(
					Object.entries(files).map(([path, content]) => ({
						versionId: id,
						path,
						content: new TextEncoder().encode(content),
					})),
				);
				ids.push(id);
			}
			await db
				.update(schema.skill)
				.set({ currentVersionId: ids.at(-1) })
				.where(sql`name = ${name}`);
			return ids;
		}
		const left = async () =>
			(
				await db.execute<{ n: number }>(
					sql`select count(*)::int as n from skill_file where sha256 is null`,
				)
			).rows[0].n;

		it("moves every file's bytes, once, and is a no-op run again", async () => {
			const md = "---\nname: pdf\ndescription: d\n---\n";
			const [v1, v2] = await saved("pdf", [
				{ "SKILL.md": md, "a.py": "print(1)" },
				{ "SKILL.md": md, "a.py": "print(2)" },
			]);
			await saved("doc", [{ "SKILL.md": md }]);
			expect(await backfillSkillFiles(db, store)).toBe(5);
			expect(await left()).toBe(0);
			expect(text(await skillFiles(v1))).toEqual({
				"SKILL.md": md,
				"a.py": "print(1)",
			});
			expect(text(await skillFiles(v2))).toEqual({
				"SKILL.md": md,
				"a.py": "print(2)",
			});
			// pdf's SKILL.md once for both versions, doc's under doc
			expect([...objects.keys()].sort()).toEqual(
				[
					`skills/doc/${sha256(md)}`,
					`skills/pdf/${sha256("print(1)")}`,
					`skills/pdf/${sha256("print(2)")}`,
					`skills/pdf/${sha256(md)}`,
				].sort(),
			);
			const [{ size }] = await db
				.select({ size: schema.skillFile.size })
				.from(schema.skillFile)
				.where(sql`version_id = ${v2} and path = 'a.py'`);
			expect(size).toBe(8);
			puts.left = 0;
			expect(await backfillSkillFiles(db, store)).toBe(0);
		});

		it("moves what is left after an interruption, losing nothing already moved", async () => {
			const md = "---\nname: pdf\ndescription: d\n---\n";
			const versions = await saved("pdf", [
				{ "SKILL.md": md, "a.py": "print(1)" },
				{ "SKILL.md": md, "a.py": "print(2)" },
				{ "SKILL.md": md, "a.py": "print(3)" },
			]);
			// the first version's two files go up, then object storage goes down
			puts.left = 2;
			await expect(backfillSkillFiles(db, store)).rejects.toThrow(/down/);
			expect(await left()).toBe(4);
			puts.left = Number.POSITIVE_INFINITY;
			expect(await backfillSkillFiles(db, store)).toBe(4);
			for (const [i, id] of versions.entries())
				expect(text(await skillFiles(id))).toEqual({
					"SKILL.md": md,
					"a.py": `print(${i + 1})`,
				});
		});
	});

	it("is unavailable while disabled", async () => {
		await skills.upload(skillZip("pdf", "d"), false);
		await skills.setEnabled("pdf", false);
		expect(await skills.current()).toEqual({});
		expect((await skills.list())[0].enabled).toBe(false);
		await skills.setEnabled("pdf", true);
		expect(Object.keys(await skills.current())).toEqual(["pdf"]);
	});
});
