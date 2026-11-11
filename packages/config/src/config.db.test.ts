import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SkillFile } from "./shared.ts";

// Writes through the interface against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { sql } = await import("drizzle-orm");
const { config, liveConfig } = await import("./live.ts");
const { catalogProviders } = await import("./index.ts");
const { skillFiles, limitsInput } = await import("./live.ts");
const { zip } = await import("./test-zip.ts");
const { decryptSecret } = await import("./secret.ts");

const general = {
	name: "General",
	description: "d",
	instructions: "",
	default: true,
};
const other = { name: "Other", description: "d", instructions: "" };
// nothing listens there, so the connection test fails fast
const mcp = (id: string) => ({
	id,
	create: true,
	name: id,
	url: "http://127.0.0.1:9/mcp",
	enabled: true,
	auth: "shared" as "shared" | "oauth",
	headers: [],
});

// a write reloads asynchronously in other processes
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 50; i++) {
		const value = await read();
		if (ok(value)) return value;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

describe.skipIf(!url)("@orqestra/config writes (Postgres)", () => {
	// leaves only a default Agent, as the baseline does, also for the next package's tests
	const reset = async () => {
		await db.execute(
			sql`truncate provider, enabled_model, search_provider, tool_service, mcp_server, sandbox_provider, document_parser, agent, skill, limits cascade`,
		);
		await config.agents.save({
			id: "general",
			create: true,
			definition: general,
		});
	};
	beforeEach(reset);
	afterAll(async () => {
		await reset();
		await config.close();
	});

	describe("Providers", () => {
		it("requires an API key on the first save", async () => {
			const result = await config.providers.save({
				id: "deepseek",
				apiKey: "",
				baseUrl: "https://api.deepseek.com",
			});
			expect(result.errors).toEqual({ apiKey: { code: "api_key_required" } });
			expect((await config.providers.list()).configured).toEqual([]);
		});

		it("stores no baseUrl when it is the Catalog's, and keeps the key when left blank", async () => {
			const catalog = (await catalogProviders()).find(
				(p) => p.id === "deepseek",
			);
			const baseUrl = `${catalog?.baseUrl}/`;
			expect(
				await config.providers.save({ id: "deepseek", apiKey: "sk", baseUrl }),
			).toEqual({ errors: {} });
			expect(
				await config.providers.save({ id: "deepseek", apiKey: "", baseUrl }),
			).toEqual({ errors: {} });
			expect((await config.providers.list()).configured).toEqual([
				{
					id: "deepseek",
					baseUrl: null,
					keyReadable: true,
					enabledModels: [],
				},
			]);
		});

		it("refuses to enable a Model that is not in the Catalog", async () => {
			await config.providers.save({
				id: "deepseek",
				apiKey: "sk",
				baseUrl: "http://10.0.0.1",
			});
			await expect(
				config.providers.setModelEnabled({
					providerId: "deepseek",
					modelId: "gone",
					enabled: true,
				}),
			).rejects.toThrow(/not in the Catalog/);
		});
	});

	describe("Search Providers", () => {
		it("keeps the stored key when left blank and the official baseUrl as none", async () => {
			const save = (apiKey: string) =>
				config.searchProviders.save({
					id: "tavily",
					apiKey,
					baseUrl: "https://api.tavily.com/",
				});
			expect(await save("tvly-1")).toEqual({ errors: {} });
			await config.searchProviders.serve("search", "tavily");
			expect(await save("")).toEqual({ errors: {} });
			expect((await config.current()).tools.search).toEqual({
				provider: "tavily",
				apiKey: "tvly-1",
				baseUrl: "https://api.tavily.com",
			});
			expect((await config.searchProviders.list()).configured).toEqual([
				{ id: "tavily", keyReadable: true, baseUrl: null },
			]);
		});

		it("requires an API key on the first save", async () => {
			expect(
				await config.searchProviders.save({
					id: "tavily",
					apiKey: "",
					baseUrl: "https://api.tavily.com",
				}),
			).toEqual({ errors: { apiKey: { code: "api_key_required" } } });
		});

		it("leaves its Tools unavailable once deleted", async () => {
			await config.searchProviders.save({
				id: "tavily",
				apiKey: "k",
				baseUrl: "https://api.tavily.com",
			});
			await config.searchProviders.serve("search", "tavily");
			await config.searchProviders.serve("scrape", "tavily");
			expect((await config.searchProviders.list()).available).toEqual([
				"search",
				"scrape",
			]);
			await config.searchProviders.delete("tavily");
			expect(await config.searchProviders.list()).toMatchObject({
				servedBy: { search: null, scrape: null },
				available: [],
			});
			expect((await config.agents.list()).availableTools).toEqual([]);
		});
	});

	describe("MCP Servers", () => {
		it("keeps a header's stored value when left blank, by name", async () => {
			const saved = await config.mcpServers.save({
				...mcp("docs"),
				headers: [{ name: "Authorization", value: "Bearer 1" }],
			});
			expect(saved).toMatchObject({
				errors: {},
				test: { ok: false, reason: "unreachable" },
			});
			await config.mcpServers.save({
				...mcp("docs"),
				create: false,
				headers: [{ name: "Authorization", value: "" }],
			});
			expect((await config.current()).mcpServers.docs.headers).toEqual({
				Authorization: "Bearer 1",
			});
			expect((await config.mcpServers.list())[0].headers).toEqual([
				{ name: "Authorization", readable: true },
			]);
		});

		it("returns field errors as codes", async () => {
			await config.mcpServers.save(mcp("docs"));
			expect((await config.mcpServers.save(mcp("docs"))).errors).toEqual({
				id: { code: "id_taken" },
			});
			expect((await config.mcpServers.save(mcp("Docs"))).errors).toEqual({
				id: { code: "id_invalid" },
			});
			expect(
				(
					await config.mcpServers.save({
						...mcp("x"),
						headers: [
							{ name: "A", value: "1" },
							{ name: "a", value: "2" },
						],
					})
				).errors,
			).toEqual({ headers: { code: "header_twice", header: "a" } });
		});

		it("is removed from every Agent Definition when deleted", async () => {
			await config.mcpServers.save(mcp("docs"));
			await config.mcpServers.save(mcp("files"));
			const tools = ["search", "mcp:docs", "mcp:files"];
			await config.agents.save({
				id: "general",
				create: false,
				definition: { ...general, tools },
			});
			await config.agents.save({
				id: "other",
				create: true,
				definition: { ...other, tools: ["mcp:docs"] },
			});
			await config.mcpServers.delete("docs");
			const { agents, mcpServers } = await config.agents.list();
			expect(agents.map((a) => [a.id, a.definition.tools])).toEqual([
				["general", ["search", "mcp:files"]],
				["other", []],
			]);
			expect(mcpServers).toEqual([{ id: "files", name: "files" }]);
		});

		it("is shared when stored before it had an auth mode, as after the migration", async () => {
			await db.execute(
				sql`insert into mcp_server (id, name, url) values ('docs', 'Docs', 'http://127.0.0.1:9/mcp')`,
			);
			expect((await config.mcpServers.list())[0]).toMatchObject({
				auth: "shared",
				oauthClientId: null,
				oauthClientSecret: null,
			});
			// written past config, so read by a fresh one
			const fresh = liveConfig();
			try {
				expect((await fresh.get()).mcpServers.docs.auth).toBe("shared");
			} finally {
				await fresh.close();
			}
		});

		it("stores a pre-registered Client Secret encrypted, keeps it when left blank, and lists only whether it is readable", async () => {
			const oauth = {
				...mcp("docs"),
				auth: "oauth" as const,
				oauthClientId: "orq",
			};
			await config.mcpServers.save({ ...oauth, oauthClientSecret: "s3cret" });
			const stored = async () =>
				(
					await db.execute<{ oauth_client_secret: string }>(
						sql`select oauth_client_secret from mcp_server where id = 'docs'`,
					)
				).rows[0].oauth_client_secret;
			const first = await stored();
			expect(first).not.toContain("s3cret");
			expect(decryptSecret(first)).toBe("s3cret");
			await config.mcpServers.save({
				...oauth,
				create: false,
				oauthClientSecret: "",
			});
			expect(await stored()).toBe(first);
			const [listed] = await config.mcpServers.list();
			expect(listed).toMatchObject({
				auth: "oauth" as const,
				oauthClientId: "orq",
				oauthClientSecret: { readable: true },
			});
			expect(JSON.stringify(listed)).not.toContain("s3cret");
			expect((await config.current()).mcpServers.docs.auth).toBe("oauth");
		});
	});

	describe("Skills", () => {
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
			const skill = (await config.current()).skills[name];
			return skill && text(await skillFiles(skill.versionId));
		};

		it("refuses an invalid zip with the reason", async () => {
			expect(await config.skills.upload(zip([]), false)).toEqual({
				errors: { file: { code: "skill_md_missing" } },
			});
			expect(await config.skills.list()).toEqual([]);
		});

		it("makes an uploaded Skill available to Runs with its files", async () => {
			expect(
				await config.skills.upload(
					skillZip("pdf", "Fills PDFs", { "scripts/a.py": "print(1)" }),
					false,
				),
			).toEqual({ errors: {}, name: "pdf" });
			expect((await config.current()).skills.pdf).toMatchObject({
				description: "Fills PDFs",
				disableModelInvocation: false,
			});
			expect(await currentFiles("pdf")).toEqual({
				"SKILL.md": "---\nname: pdf\ndescription: Fills PDFs\n---\nBody\n",
				"scripts/a.py": "print(1)",
			});
		});

		it("asks before uploading a name that exists, then adds a version", async () => {
			await config.skills.upload(skillZip("pdf", "v1"), false);
			expect(await config.skills.upload(skillZip("pdf", "v2"), false)).toEqual({
				errors: { name: { code: "skill_exists" } },
				name: "pdf",
			});
			expect((await config.current()).skills.pdf.description).toBe("v1");
			await config.skills.upload(skillZip("pdf", "v2"), true);
			const [listed, ...others] = await config.skills.list();
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
			await config.skills.upload(skillZip("pdf", "v1", { a: "old" }), false);
			await config.skills.upload(skillZip("pdf", "v2", { b: "new" }), true);
			const [{ versions }] = await config.skills.list();
			await config.skills.setCurrent("pdf", versions[1].id);
			expect((await config.current()).skills.pdf.description).toBe("v1");
			expect(Object.keys(await currentFiles("pdf"))).toEqual(["SKILL.md", "a"]);
			// another Skill's version is not one of its own
			await config.skills.upload(skillZip("doc", "d"), false);
			const doc = (await config.skills.list()).find((s) => s.name === "doc");
			await expect(
				config.skills.setCurrent("pdf", doc?.versions[0].id ?? 0),
			).rejects.toThrow(/not found/);
		});

		it("creates a Skill with a SKILL.md carrying its name and description", async () => {
			expect(await config.skills.create("pdf", 'Fills PDFs: "forms"')).toEqual({
				errors: {},
			});
			expect(await currentFiles("pdf")).toEqual({
				"SKILL.md":
					'---\nname: pdf\ndescription: "Fills PDFs: \\"forms\\""\n---\n\n',
			});
			expect((await config.current()).skills.pdf.description).toBe(
				'Fills PDFs: "forms"',
			);
			expect(await config.skills.create("pdf", "again")).toEqual({
				errors: { name: { code: "skill_exists" } },
			});
			expect(await config.skills.create("Bad Name", "d")).toEqual({
				errors: { name: { code: "skill_name_invalid" } },
			});
			expect(await config.skills.create("doc", " ")).toEqual({
				errors: { description: { code: "skill_description_invalid" } },
			});
			expect((await config.skills.list()).map((s) => s.name)).toEqual(["pdf"]);
		});

		it("saves edited files as a new version, keeping binary files untouched", async () => {
			const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
			await config.skills.upload(
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
			const [{ currentVersionId }] = await config.skills.list();
			const base = currentVersionId ?? 0;
			expect(await config.skills.files(base)).toEqual([
				{
					path: "SKILL.md",
					size: 34,
					text: "---\nname: pdf\ndescription: v1\n---\n",
				},
				{ path: "assets/logo.png", size: 6 },
				{ path: "scripts/a.py", size: 8, text: "print(1)" },
			]);
			expect(
				await config.skills.edit("pdf", base, [
					{ path: "SKILL.md", text: "---\nname: pdf\ndescription: v2\n---\n" },
					{ path: "scripts/b.py", text: "print(2)" },
					{ path: "assets/logo.png" },
				]),
			).toEqual({ errors: {} });
			expect((await config.current()).skills.pdf.description).toBe("v2");
			const files = await currentFiles("pdf");
			expect(Object.keys(files).sort()).toEqual([
				"SKILL.md",
				"assets/logo.png",
				"scripts/b.py",
			]);
			const version = (await config.current()).skills.pdf.versionId;
			const logo = (await skillFiles(version)).find(
				(f) => f.path === "assets/logo.png",
			);
			expect(Buffer.from(logo?.content ?? [])).toEqual(png);
			expect((await config.skills.list())[0].versions).toHaveLength(2);
		});

		it("refuses text for a binary file, and a path given twice", async () => {
			await config.skills.upload(
				zip([
					{
						path: "SKILL.md",
						content: "---\nname: pdf\ndescription: v1\n---\n",
					},
					{ path: "logo.png", content: Buffer.from([0x89, 0x00, 0xff]) },
				]),
				false,
			);
			const [{ currentVersionId }] = await config.skills.list();
			const base = currentVersionId ?? 0;
			const md = {
				path: "SKILL.md",
				text: "---\nname: pdf\ndescription: v2\n---\n",
			};
			expect(
				await config.skills.edit("pdf", base, [
					md,
					{ path: "logo.png", text: "x" },
				]),
			).toEqual({
				errors: { file: { code: "skill_file_binary", path: "logo.png" } },
			});
			expect(
				await config.skills.edit("pdf", base, [
					md,
					{ path: "a.md", text: "1" },
					{ path: "a.md", text: "2" },
				]),
			).toEqual({
				errors: { file: { code: "skill_path_duplicate", path: "a.md" } },
			});
			expect((await config.skills.list())[0].versions).toHaveLength(1);
		});

		it("refuses an edit the standard or the Skill's name does not allow", async () => {
			await config.skills.create("pdf", "d");
			const [{ currentVersionId }] = await config.skills.list();
			const base = currentVersionId ?? 0;
			const md = (name: string) => ({
				path: "SKILL.md",
				text: `---\nname: ${name}\ndescription: d\n---\n`,
			});
			expect(await config.skills.edit("pdf", base, [md("doc")])).toEqual({
				errors: {
					file: { code: "skill_name_mismatch", name: "doc", folder: "pdf" },
				},
			});
			expect(
				await config.skills.edit("pdf", base, [
					md("pdf"),
					{ path: "../x", text: "" },
				]),
			).toEqual({
				errors: { file: { code: "skill_path_unsafe", path: "../x" } },
			});
			// a kept file must be one of the version's
			expect(
				await config.skills.edit("pdf", base, [
					md("pdf"),
					{ path: "gone.png" },
				]),
			).toEqual({ errors: { file: { code: "not_found" } } });
			await config.skills.create("doc", "d");
			await expect(
				config.skills.edit("doc", base, [md("doc")]),
			).rejects.toThrow(/not found/);
			expect((await config.skills.list())[1].versions).toHaveLength(1);
		});

		it("is unavailable while disabled", async () => {
			await config.skills.upload(skillZip("pdf", "d"), false);
			await config.skills.setEnabled("pdf", false);
			expect((await config.current()).skills).toEqual({});
			expect((await config.skills.list())[0].enabled).toBe(false);
			await config.skills.setEnabled("pdf", true);
			expect(Object.keys((await config.current()).skills)).toEqual(["pdf"]);
		});

		it("is removed from every Agent Definition when deleted", async () => {
			await config.skills.upload(skillZip("pdf", "d"), false);
			await config.skills.upload(skillZip("doc", "d"), false);
			await config.agents.save({
				id: "general",
				create: false,
				definition: { ...general, skills: ["pdf", "doc"] },
			});
			await config.agents.save({
				id: "other",
				create: true,
				definition: { ...other, skills: ["pdf"] },
			});
			await config.skills.delete("pdf");
			const { agents } = await config.agents.list();
			expect(agents.map((a) => [a.id, a.definition.skills])).toEqual([
				["general", ["doc"]],
				["other", []],
			]);
			expect((await config.skills.list()).map((s) => s.name)).toEqual(["doc"]);
		});

		it("lists every Skill for the Agent form, available once enabled with a Sandbox Provider", async () => {
			await config.skills.upload(skillZip("pdf", "d"), false);
			await config.skills.upload(skillZip("doc", "d"), false);
			await config.skills.setEnabled("doc", false);
			expect(await config.agents.list()).toMatchObject({
				skills: ["doc", "pdf"],
				availableSkills: [],
			});
			await config.sandboxProvider.save({
				url: "http://127.0.0.1:9",
				token: "orr_1_s",
				snapshot: "",
				cpu: 2,
				memory: 2147483648,
			});
			expect((await config.agents.list()).availableSkills).toEqual(["pdf"]);
		});
	});

	describe("Sandbox Provider", () => {
		// nothing listens there, so the connection test fails fast
		const orrery = {
			url: "http://127.0.0.1:9",
			token: "orr_1_s",
			snapshot: "",
			cpu: 2,
			memory: 2147483648,
		};

		it("requires a token on the first save", async () => {
			expect(
				await config.sandboxProvider.save({ ...orrery, token: "" }),
			).toEqual({ errors: { token: { code: "token_required" } } });
			expect(await config.sandboxProvider.get()).toBeNull();
		});

		it("is saved even when the connection test fails, and keeps the token when left blank", async () => {
			const saved = await config.sandboxProvider.save(orrery);
			expect(saved).toMatchObject({
				errors: {},
				test: { ok: false, reason: "unreachable" },
			});
			await config.sandboxProvider.save({
				...orrery,
				token: "",
				snapshot: "skills",
				cpu: 4,
			});
			expect(await config.sandboxProvider.get()).toEqual({
				url: "http://127.0.0.1:9",
				tokenReadable: true,
				snapshot: "skills",
				cpu: 4,
				memory: 2147483648,
			});
			expect((await config.current()).sandboxProvider).toEqual({
				url: "http://127.0.0.1:9",
				token: "orr_1_s",
				snapshot: "skills",
				cpu: 4,
				memory: 2147483648,
			});
		});

		it("is unavailable once deleted", async () => {
			await config.sandboxProvider.save(orrery);
			await config.sandboxProvider.delete();
			expect(await config.sandboxProvider.get()).toBeNull();
			expect((await config.current()).sandboxProvider).toBeUndefined();
		});
	});

	describe("Document Parser", () => {
		// nothing listens there, so the connection test fails fast
		const selfHosted = { enabled: true, url: "http://127.0.0.1:9", apiKey: "" };

		it("requires a key for mineru.net", async () => {
			expect(
				await config.documentParser.save({
					enabled: true,
					url: "https://mineru.net",
					apiKey: "",
				}),
			).toEqual({ errors: { apiKey: { code: "api_key_required" } } });
			expect(await config.documentParser.get()).toBeNull();
		});

		it("serves Parse from a self-hosted MinerU without a key, saved even when the connection test fails", async () => {
			expect(await config.documentParser.save(selfHosted)).toMatchObject({
				errors: {},
				test: { ok: false, reason: "unreachable" },
			});
			expect(await config.documentParser.get()).toEqual({
				enabled: true,
				url: "http://127.0.0.1:9",
				keyReadable: null,
			});
			expect((await config.current()).tools.parse).toEqual({
				baseUrl: "http://127.0.0.1:9",
				apiKey: "",
			});
		});

		it("stores the key encrypted and keeps it when left blank", async () => {
			await config.documentParser.save({ ...selfHosted, apiKey: "mk" });
			await config.documentParser.save(selfHosted);
			const [row] = (await db.execute(sql`select api_key from document_parser`))
				.rows as { api_key: string }[];
			expect(row.api_key).not.toContain("mk");
			expect(await config.documentParser.get()).toMatchObject({
				keyReadable: true,
			});
			expect((await config.current()).tools.parse?.apiKey).toBe("mk");
		});

		it("leaves Parse unavailable while disabled, and once deleted", async () => {
			await config.documentParser.save({ ...selfHosted, enabled: false });
			expect((await config.current()).tools.parse).toBeUndefined();
			expect((await config.agents.list()).availableTools).not.toContain(
				"parse",
			);
			await config.documentParser.save(selfHosted);
			expect((await config.agents.list()).availableTools).toContain("parse");
			await config.documentParser.delete();
			expect(await config.documentParser.get()).toBeNull();
			expect((await config.current()).tools.parse).toBeUndefined();
		});
	});

	describe("Limits", () => {
		const defaults = {
			maxScheduledTasksPerUser: 10,
			minFiringInterval: 3600,
			timerRingsPerUserMessage: 10,
			unattendedMaxSteps: 50,
			unattendedMaxDuration: 1800,
			maxSubagentDepth: 2,
			spendingLimit: { mode: "unlimited" as const },
			resetTimeZone: "UTC",
			backgroundCallMaxDuration: 86400,
		};

		it("are the defaults until an Admin saves them, and Runs read the saved ones at once", async () => {
			expect(await config.limits.get()).toEqual(defaults);
			expect((await config.current()).limits).toEqual(defaults);
			const changed = {
				...defaults,
				unattendedMaxSteps: 5,
				maxSubagentDepth: 3,
			};
			expect(await config.limits.save(changed)).toEqual({ errors: {} });
			expect(await config.limits.get()).toEqual(changed);
			expect((await config.current()).limits).toEqual(changed);
		});

		it("refuse a maximum Subagent depth outside 1 to 3, counts below 1, and a Background Call tracked under a minute or over 30 days", () => {
			for (const maxSubagentDepth of [0, 4])
				expect(
					limitsInput.safeParse({ ...defaults, maxSubagentDepth }).success,
				).toBe(false);
			expect(
				limitsInput.safeParse({ ...defaults, unattendedMaxSteps: 0 }).success,
			).toBe(false);
			// a Background Call is tracked from a minute to 30 days
			for (const backgroundCallMaxDuration of [59, 30 * 86400 + 1, 90.5])
				expect(
					limitsInput.safeParse({ ...defaults, backgroundCallMaxDuration })
						.success,
				).toBe(false);
			for (const backgroundCallMaxDuration of [60, 30 * 86400])
				expect(
					limitsInput.safeParse({ ...defaults, backgroundCallMaxDuration })
						.success,
				).toBe(true);
			expect(limitsInput.safeParse(defaults).success).toBe(true);
		});

		it("keep a default Spending Limit of so many dollars, $0 included, refusing one without an amount or below 0, and a reset time zone", async () => {
			const valid = (spendingLimit: unknown) =>
				limitsInput.safeParse({ ...defaults, spendingLimit }).success;
			expect(valid({ mode: "limited" })).toBe(false);
			expect(valid({ mode: "limited", usd: -1 })).toBe(false);
			expect(valid({ mode: "limited", usd: 0 })).toBe(true);
			expect(
				limitsInput.safeParse({ ...defaults, resetTimeZone: "Mars/Base" })
					.success,
			).toBe(false);
			const changed = {
				...defaults,
				spendingLimit: { mode: "limited" as const, usd: 0 },
				resetTimeZone: "Asia/Shanghai",
			};
			await config.limits.save(changed);
			expect(await config.limits.get()).toEqual(changed);
			expect((await config.current()).limits).toEqual(changed);
		});
	});

	describe("Agent Definitions", () => {
		it("lets a new default Agent take over from the old one", async () => {
			await config.agents.save({
				id: "other",
				create: true,
				definition: { ...other, default: true },
			});
			const { agents } = await config.agents.list();
			expect(agents.map((a) => [a.id, a.definition.default])).toEqual([
				["general", false],
				["other", true],
			]);
			expect((await config.current()).defaultAgent.id).toBe("other");
		});

		it("refuses to delete the default Agent or to unset it", async () => {
			await expect(config.agents.delete("general")).rejects.toThrow(
				/default Agent cannot be deleted/,
			);
			expect(
				await config.agents.save({
					id: "general",
					create: false,
					definition: { ...general, default: false },
				}),
			).toEqual({ errors: { default: { code: "default_required" } } });
		});

		it("returns invalid fields as codes, keeping zod's message as detail", async () => {
			const { errors } = await config.agents.save({
				id: "x",
				create: true,
				definition: { ...other, name: "" },
			});
			expect(errors).toEqual({
				name: { code: "invalid", detail: expect.any(String) },
			});
			expect(
				(
					await config.agents.save({
						id: "general",
						create: true,
						definition: general,
					})
				).errors,
			).toEqual({ id: { code: "id_taken" } });
			expect(
				(
					await config.agents.save({
						id: "x",
						create: true,
						definition: { ...other, models: ["a/b"], defaultModel: "a/c" },
					})
				).errors,
			).toEqual({
				defaultModel: { code: "default_model_not_allowed", model: "a/c" },
			});
		});
	});

	it("tells every other process to reload after a write", async () => {
		const elsewhere = liveConfig();
		try {
			expect((await elsewhere.get()).agents.map((a) => a.id)).toEqual([
				"general",
			]);
			await config.agents.save({
				id: "other",
				create: true,
				definition: other,
			});
			await eventually(
				() => elsewhere.get(),
				(c) => c.agents.some((a) => a.id === "other"),
			);
		} finally {
			await elsewhere.close();
		}
	});
});
