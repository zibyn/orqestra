import { describe, expect, it } from "vitest";
import { parseSkillZip } from "./skill-zip.ts";
import { type Entry, zip } from "./test-zip.ts";

const skillMd = (front: string, body = "Use it well.") =>
	`---\n${front}\n---\n\n${body}\n`;
const pdf = skillMd("name: pdf-tools\ndescription: Fills PDF forms");

const error = (bytes: Uint8Array) => {
	const result = parseSkillZip(bytes);
	return "error" in result ? result.error : undefined;
};

describe("parseSkillZip", () => {
	it("reads a Skill in a top-level folder named after it, with paths relative to that folder", () => {
		const result = parseSkillZip(
			zip([
				{ path: "pdf-tools/", mode: 0o40755 },
				{ path: "pdf-tools/SKILL.md", content: pdf },
				{ path: "pdf-tools/scripts/fill.py", content: "print(1)" },
			]),
		);
		expect(result).toEqual({
			skill: {
				name: "pdf-tools",
				description: "Fills PDF forms",
				disableModelInvocation: false,
				files: [
					{ path: "SKILL.md", content: new Uint8Array(Buffer.from(pdf)) },
					{
						path: "scripts/fill.py",
						content: new Uint8Array(Buffer.from("print(1)")),
					},
				],
			},
		});
	});

	it("reads a SKILL.md at the root, and disable-model-invocation", () => {
		const result = parseSkillZip(
			zip([
				{
					path: "SKILL.md",
					content: skillMd(
						"name: pdf-tools\ndescription: d\ndisable-model-invocation: true",
					),
				},
				{ path: "references/a.md", content: "a" },
			]),
		);
		expect("skill" in result && result.skill.disableModelInvocation).toBe(true);
		expect("skill" in result && result.skill.files.map((f) => f.path)).toEqual([
			"SKILL.md",
			"references/a.md",
		]);
	});

	it("ignores macOS metadata", () => {
		const result = parseSkillZip(
			zip([
				{ path: "pdf-tools/SKILL.md", content: pdf },
				{ path: "__MACOSX/pdf-tools/._SKILL.md", content: "x" },
				{ path: "pdf-tools/.DS_Store", content: "x" },
			]),
		);
		expect("skill" in result && result.skill.files.map((f) => f.path)).toEqual([
			"SKILL.md",
		]);
	});

	it("refuses what is not a zip", () => {
		expect(error(new TextEncoder().encode("hello"))).toEqual({
			code: "skill_zip_invalid",
		});
	});

	it("needs a SKILL.md at the root or in the only top-level folder", () => {
		expect(error(zip([{ path: "README.md", content: "x" }]))).toEqual({
			code: "skill_md_missing",
		});
		expect(
			error(
				zip([
					{ path: "a/SKILL.md", content: pdf },
					{ path: "b/SKILL.md", content: pdf },
				]),
			),
		).toEqual({ code: "skill_md_missing" });
		expect(
			error(zip([{ path: "pdf-tools/sub/SKILL.md", content: pdf }])),
		).toEqual({ code: "skill_md_missing" });
	});

	it("needs frontmatter", () => {
		expect(
			error(zip([{ path: "SKILL.md", content: "no frontmatter" }])),
		).toEqual({ code: "skill_name_invalid" });
		expect(
			error(zip([{ path: "SKILL.md", content: "---\nname: [a\n---\n" }])),
		).toEqual({ code: "skill_frontmatter_invalid" });
	});

	it("checks the name against the standard and the folder", () => {
		const named = (name: string) =>
			error(
				zip([
					{
						path: "SKILL.md",
						content: skillMd(`name: ${name}\ndescription: d`),
					},
				]),
			);
		expect(named("PDF")).toEqual({ code: "skill_name_invalid" });
		expect(named("-pdf")).toEqual({ code: "skill_name_invalid" });
		expect(named("pdf--tools")).toEqual({ code: "skill_name_invalid" });
		expect(named("a".repeat(65))).toEqual({ code: "skill_name_invalid" });
		expect(named("a".repeat(64))).toBeUndefined();
		expect(error(zip([{ path: "other/SKILL.md", content: pdf }]))).toEqual({
			code: "skill_name_mismatch",
			name: "pdf-tools",
			folder: "other",
		});
	});

	it("needs a description of at most 1024 characters", () => {
		const described = (description: string) =>
			error(
				zip([
					{
						path: "SKILL.md",
						content: skillMd(`name: p\ndescription: "${description}"`),
					},
				]),
			);
		expect(described(" ")).toEqual({ code: "skill_description_invalid" });
		expect(described("d".repeat(1025))).toEqual({
			code: "skill_description_invalid",
		});
		expect(described("d".repeat(1024))).toBeUndefined();
	});

	it("refuses paths that leave the folder, and symlinks", () => {
		const withEntry = (entry: Entry) =>
			error(zip([{ path: "SKILL.md", content: pdf }, entry]));
		expect(withEntry({ path: "../evil.sh", content: "x" })).toEqual({
			code: "skill_path_unsafe",
			path: "../evil.sh",
		});
		expect(withEntry({ path: "a/../../evil.sh", content: "x" })).toEqual({
			code: "skill_path_unsafe",
			path: "a/../../evil.sh",
		});
		expect(withEntry({ path: "/etc/passwd", content: "x" })).toEqual({
			code: "skill_path_unsafe",
			path: "/etc/passwd",
		});
		expect(withEntry({ path: "a\\..\\b", content: "x" })).toEqual({
			code: "skill_path_unsafe",
			path: "a\\..\\b",
		});
		expect(
			withEntry({ path: "link", content: "/etc/passwd", mode: 0o120777 }),
		).toEqual({ code: "skill_symlink", path: "link" });
	});

	it("allows at most 200 files and 10 MB unzipped", () => {
		const files = (n: number) =>
			Array.from({ length: n }, (_, i) => ({ path: `f${i}`, content: "x" }));
		expect(
			error(zip([{ path: "SKILL.md", content: pdf }, ...files(199)])),
		).toBeUndefined();
		expect(
			error(zip([{ path: "SKILL.md", content: pdf }, ...files(200)])),
		).toEqual({ code: "skill_too_many_files" });
		expect(
			error(
				zip([
					{ path: "SKILL.md", content: pdf },
					{ path: "big", content: Buffer.alloc(10 * 1024 * 1024) },
				]),
			),
		).toEqual({ code: "skill_too_large" });
	});
});
