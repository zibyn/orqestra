import { createHash } from "node:crypto";
import type { ObjectStore } from "@orqestra/db/store";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
/**
 * Puts wait for `puts.before`, then fail once `puts.left` reaches 0, deleting the key unless `keepOnFailure`, as s3Store
 * does after a failed multipart upload. Deleting a prefix waits for `deletes.before`; with `deletes.fail` it stops after
 * its first object; `deletes.after` runs after one.
 */
const puts = {
	left: Number.POSITIVE_INFINITY,
	before: undefined as
		| ((
				key: string,
				signal?: AbortSignal,
				keepOnFailure?: boolean,
		  ) => Promise<void>)
		| undefined,
};
const deletes = {
	before: undefined as ((signal?: AbortSignal) => Promise<void>) | undefined,
	fail: false,
	after: undefined as (() => Promise<void>) | undefined,
};
const store: ObjectStore = {
	...memory,
	put: async (key, body, options) => {
		await puts.before?.(key, options?.signal, options?.keepOnFailure);
		if (puts.left-- <= 0) {
			if (!options?.keepOnFailure) objects.delete(key);
			throw new Error("object storage is down");
		}
		await memory.put(key, body);
	},
	deletePrefix: async (prefix, options) => {
		await deletes.before?.(options?.signal);
		if (deletes.fail) {
			objects.delete(
				[...objects.keys()].find((k) => k.startsWith(prefix)) ?? "",
			);
			throw new Error("object storage is down");
		}
		await memory.deletePrefix(prefix);
		await deletes.after?.();
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
		puts.before = undefined;
		deletes.before = undefined;
		deletes.fail = false;
		deletes.after = undefined;
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

	it("deletes a Skill though object storage fails partway, and its name takes every file of a new upload", async () => {
		const files = { "a.py": "print(1)" };
		await skills.upload(skillZip("pdf", "d", files), false);
		deletes.fail = true;
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		await skills.delete("pdf");
		logged.mockRestore();
		expect(await skills.list()).toEqual([]);
		// the file left is named by nothing
		expect(objects.size).toBe(1);
		deletes.fail = false;
		await skills.upload(skillZip("pdf", "d", files), false);
		expect(await currentFiles("pdf")).toEqual({
			"SKILL.md": "---\nname: pdf\ndescription: d\n---\nBody\n",
			"a.py": "print(1)",
		});
		await skills.delete("pdf");
		expect(objects.size).toBe(0);
	});

	it("lets a Run reading a Skill being deleted find all its files, or no version", async () => {
		await skills.upload(skillZip("pdf", "d", { "a.py": "print(1)" }), false);
		const { versionId } = (await skills.current()).pdf;
		let read: unknown;
		deletes.after = async () => {
			read = await skillFiles(versionId).catch((error) => error);
		};
		await skills.delete("pdf");
		expect(read).toEqual([]);
	});

	it("keeps the files of a Skill uploaded under the name while the deleted one's go", async () => {
		await skills.upload(skillZip("pdf", "old", { "a.py": "old" }), false);
		// the upload lands after the delete's rows are gone, before its objects go
		let transactions = 0;
		const racing = createSkills(
			Object.assign(Object.create(db), {
				transaction: async (fn: Parameters<typeof db.transaction>[0]) => {
					if (++transactions === 2)
						await skills.upload(
							skillZip("pdf", "new", { "a.py": "new" }),
							false,
						);
					return db.transaction(fn);
				},
			}),
			store,
		);
		await racing.delete("pdf");
		expect(transactions).toBe(2);
		expect(await currentFiles("pdf")).toEqual({
			"SKILL.md": "---\nname: pdf\ndescription: new\n---\nBody\n",
			"a.py": "new",
		});
	});

	it("saves two versions of a Skill at once one after the other, so neither takes the other's number or files", async () => {
		await skills.upload(skillZip("pdf", "v1"), false);
		/** Saves two with the same b.py at once, the first's put of it held until the second has had time to run, then ending as `first`. */
		async function race(first: "fails" | "saves") {
			let release = () => {};
			const held = new Promise<void>((r) => {
				release = r;
			});
			let reached = () => {};
			const putting = new Promise<void>((r) => {
				reached = r;
			});
			puts.before = async (key) => {
				if (!key.endsWith(sha256(first))) return;
				puts.before = undefined;
				reached();
				await held;
				if (first === "fails") {
					objects.delete(key);
					throw new Error("object storage is down");
				}
			};
			const a = skills.upload(skillZip("pdf", "a", { "b.py": first }), true);
			await putting;
			const b = skills.upload(skillZip("pdf", "b", { "b.py": first }), true);
			await new Promise((r) => setTimeout(r, 200));
			release();
			const [saved, other] = await Promise.allSettled([a, b]);
			return [saved.status, other.status];
		}
		// the first's failed put deletes its object, which the second would have put meanwhile without the lock
		expect(await race("fails")).toEqual(["rejected", "fulfilled"]);
		expect(await currentFiles("pdf")).toMatchObject({ "b.py": "fails" });
		// the second would have landed first without the lock
		expect(await race("saves")).toEqual(["fulfilled", "fulfilled"]);
		const [{ versions }] = await skills.list();
		expect(versions.map((v) => [v.number, v.description])).toEqual([
			[4, "b"],
			[3, "a"],
			[2, "b"],
			[1, "v1"],
		]);
		expect(await currentFiles("pdf")).toMatchObject({ "b.py": "saves" });
	});

	it("keeps every file of a save queued behind one that failed, though its other puts fail later", async () => {
		await skills.upload(skillZip("pdf", "v1"), false);
		let release = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		let xFailed = () => {};
		const xGone = new Promise<void>((r) => {
			xFailed = r;
		});
		let first = true;
		puts.before = async (key) => {
			if (key.endsWith(sha256("fails"))) {
				await held;
				objects.delete(key);
				throw new Error("object storage is down");
			}
			if (!key.endsWith(sha256("x")) || !first) return;
			first = false;
			await held;
			await new Promise((r) => setTimeout(r, 300));
			objects.delete(key);
			xFailed();
			throw new Error("object storage is down");
		};
		const a = skills.upload(
			skillZip("pdf", "a", { "x.py": "x", "y.py": "fails" }),
			true,
		);
		await new Promise((r) => setTimeout(r, 100));
		const b = skills.upload(skillZip("pdf", "b", { "x.py": "x" }), true);
		await new Promise((r) => setTimeout(r, 200));
		release();
		const settled = await Promise.allSettled([a, b]);
		await xGone;
		expect(settled.map((s) => s.status)).toEqual(["rejected", "fulfilled"]);
		expect(await currentFiles("pdf")).toMatchObject({ "x.py": "x" });
	});

	it("holds the name while a deleted Skill's files go, so an upload under it meanwhile keeps its own", async () => {
		await skills.upload(skillZip("pdf", "old", { "a.py": "old" }), false);
		let upload: Promise<unknown> | undefined;
		deletes.before = async () => {
			deletes.before = undefined;
			upload = skills.upload(skillZip("pdf", "new", { "a.py": "new" }), false);
			// long enough for it to save, were the name not held
			await Promise.race([upload, new Promise((r) => setTimeout(r, 200))]);
		};
		await skills.delete("pdf");
		expect(await upload).toEqual({ errors: {}, name: "pdf" });
		expect(await currentFiles("pdf")).toEqual({
			"SKILL.md": "---\nname: pdf\ndescription: new\n---\nBody\n",
			"a.py": "new",
		});
	});

	it("deletes a Skill whose object storage stops answering once its time is up, freeing the name", async () => {
		await skills.upload(skillZip("pdf", "d", { "a.py": "print(1)" }), false);
		deletes.before = (signal) =>
			new Promise<void>((_, reject) => {
				deletes.before = undefined;
				if (!signal) return;
				signal.addEventListener("abort", () => reject(signal.reason));
				if (signal.aborted) reject(signal.reason);
			});
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() =>
				AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
			);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await skills.delete("pdf");
			expect(logged).toHaveBeenCalledWith(
				"Skill pdf's files are left in storage",
				expect.objectContaining({ name: "TimeoutError" }),
			);
		} finally {
			timeout.mockRestore();
			logged.mockRestore();
		}
		expect(await skills.list()).toEqual([]);
		expect(await skills.upload(skillZip("pdf", "d"), false)).toEqual({
			errors: {},
			name: "pdf",
		});
	});

	it("deletes nothing when a put fails, so a delete storage answers late cannot take the file the next save put", async () => {
		await skills.upload(skillZip("pdf", "v1"), false);
		const late: (() => void)[] = [];
		puts.before = async (key, _, keepOnFailure) => {
			if (!key.endsWith(sha256("x"))) return;
			puts.before = undefined;
			// answered only after the next save
			if (!keepOnFailure) late.push(() => objects.delete(key));
			throw new Error("object storage is down");
		};
		await expect(
			skills.upload(skillZip("pdf", "a", { "x.py": "x" }), true),
		).rejects.toThrow(/down/);
		expect(
			await skills.upload(skillZip("pdf", "b", { "x.py": "x" }), true),
		).toEqual({ errors: {}, name: "pdf" });
		for (const land of late) land();
		expect(await currentFiles("pdf")).toMatchObject({ "x.py": "x" });
	});

	it("fails a save with what storage answered for one file, not the timeout of the others, logging those", async () => {
		await skills.upload(skillZip("pdf", "v1"), false);
		puts.before = async (key, signal) => {
			if (key.endsWith(sha256("denied"))) throw new Error("403 Forbidden");
			if (signal?.aborted) throw signal.reason;
		};
		// the time is up as soon as it starts, for every file but the one storage refused
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() =>
				AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
			);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				skills.upload(
					skillZip("pdf", "v2", { "a.py": "1", "b.py": "denied" }),
					true,
				),
			).rejects.toThrow(/403/);
			// SKILL.md's and a.py's
			expect(logged).toHaveBeenCalledTimes(2);
			expect(String(logged.mock.calls[0][1])).toMatch(/timed out/);
		} finally {
			timeout.mockRestore();
			logged.mockRestore();
		}
	});

	it("ends a save whose object storage stops answering once its time is up, freeing the Skill", async () => {
		await skills.upload(skillZip("pdf", "v1"), false);
		puts.before = (_, signal) =>
			new Promise<void>((_, reject) => {
				puts.before = undefined;
				if (!signal) return;
				signal.addEventListener("abort", () => reject(signal.reason));
				if (signal.aborted) reject(signal.reason);
			});
		// the time is up as soon as it starts
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation(() =>
				AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
			);
		try {
			await expect(
				skills.upload(skillZip("pdf", "v2", { "a.py": "1" }), true),
			).rejects.toThrow(/timed out/);
		} finally {
			timeout.mockRestore();
		}
		expect(await skills.upload(skillZip("pdf", "v3"), true)).toEqual({
			errors: {},
			name: "pdf",
		});
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

		it("reads a file not moved yet from Postgres, and a moved one only from object storage", async () => {
			const md = "---\nname: pdf\ndescription: d\n---\n";
			// as an api of the release before saves one while this one starts
			const [v1] = await saved("pdf", [{ "SKILL.md": md, "a.py": "print(1)" }]);
			expect(text(await skillFiles(v1))).toEqual({
				"SKILL.md": md,
				"a.py": "print(1)",
			});
			expect(text(await filesOf(db, store, v1, "SKILL.md"))).toEqual({
				"SKILL.md": md,
			});
			await backfillSkillFiles(db, store);
			// Postgres still has its bytes, until the migration that drops them
			objects.clear();
			await expect(skillFiles(v1)).rejects.toThrow(/not in object storage/);
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
