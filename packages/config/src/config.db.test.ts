import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Writes through the interface against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { db } = await import("@orqestra/db");
const { sql } = await import("drizzle-orm");
const { createConfig } = await import("./live.ts");
const { turnSkills } = await import("./index.ts");
const { availableTools } = await import("@orqestra/tools");
const { limitsInput } = await import("./live.ts");
const { zip } = await import("./test-zip.ts");
const { decryptSecret } = await import("@orqestra/db/secret");
const config = createConfig(db);

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
		// the Tools' config reloads on its own channel, which a truncate does not notify
		await config.sandboxProvider.delete();
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
			const fresh = createConfig(db);
			try {
				expect((await fresh.current()).mcpServers.docs.auth).toBe("shared");
			} finally {
				await fresh.close();
			}
		});

		it("stores a pre-registered Client Secret encrypted, keeps it when left blank, and lists only whether it is readable", async () => {
			const oauth = {
				...mcp("docs"),
				// a pre-registered Client makes it per-User OAuth
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

	it("leaves an MCP Server or Skill an Agent references but that was just deleted unavailable, without failing the load", async () => {
		await config.mcpServers.save(mcp("docs"));
		await config.skills.create("pdf", "d");
		await config.sandboxProvider.save({
			url: "http://127.0.0.1:9",
			token: "orr_1_s",
			snapshot: "",
			cpu: 2,
			memory: 2147483648,
		});
		await config.agents.save({
			id: "general",
			create: false,
			definition: { ...general, tools: ["mcp:docs"], skills: ["pdf"] },
		});
		// deleted past the Agent Definitions, as another snapshot may still hold them
		await db.execute(sql`delete from mcp_server where id = 'docs'`);
		await db.execute(sql`delete from skill where name = 'pdf'`);
		const fresh = createConfig(db);
		try {
			const loaded = await fresh.current();
			expect(loaded.defaultAgent).toMatchObject({
				tools: ["mcp:docs"],
				skills: ["pdf"],
			});
			expect(availableTools(loaded)).not.toContain("mcp:docs");
			expect(turnSkills(loaded, loaded.defaultAgent)).toEqual([]);
		} finally {
			await fresh.close();
		}
	});

	it("tells every other process to reload after a write", async () => {
		const elsewhere = createConfig(db);
		try {
			expect((await elsewhere.current()).agents.map((a) => a.id)).toEqual([
				"general",
			]);
			await config.agents.save({
				id: "other",
				create: true,
				definition: other,
			});
			await eventually(
				() => elsewhere.current(),
				(c) => c.agents.some((a) => a.id === "other"),
			);
		} finally {
			await elsewhere.close();
		}
	});
});
