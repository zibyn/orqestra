import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SkillFile } from "./shared.ts";

// Writes through the interface against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
const { drizzle } = await import("drizzle-orm/node-postgres");
const { sql } = await import("drizzle-orm");
const schema = await import("@orqestra/db/schema");
const { createSkills, skillFiles: filesOf } = await import("./index.ts");
const { zip } = await import("./test-zip.ts");
const db = drizzle(url ?? "", { schema });
const skills = createSkills(db);
const skillFiles = (versionId: number) => filesOf(db, versionId);

describe.skipIf(!url)("@orqestra/skills writes (Postgres)", () => {
	const reset = () => db.execute(sql`truncate skill cascade`);
	beforeEach(reset);
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
		});
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

	it("is unavailable while disabled", async () => {
		await skills.upload(skillZip("pdf", "d"), false);
		await skills.setEnabled("pdf", false);
		expect(await skills.current()).toEqual({});
		expect((await skills.list())[0].enabled).toBe(false);
		await skills.setEnabled("pdf", true);
		expect(Object.keys(await skills.current())).toEqual(["pdf"]);
	});
});
