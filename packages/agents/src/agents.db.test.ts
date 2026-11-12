import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Writes through the interface against a migrated, throwaway Postgres: TEST_DATABASE_URL is wiped before every test
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const { drizzle } = await import("drizzle-orm/node-postgres");
const { sql } = await import("drizzle-orm");
const schema = await import("@orqestra/db/schema");
const { createModels } = await import("@orqestra/models");
const { createSkills } = await import("@orqestra/skills");
const { zip } = await import("@orqestra/skills/test-zip");
const { createAgents } = await import("./live.ts");
const db = drizzle(url ?? "", { schema });
const models = createModels(db);
const skills = createSkills(db);
// nothing configured: no Tool or Skill is available to a Run
const available = async () => ({ tools: {}, mcpServers: {}, skills: {} });
const agents = createAgents(db, { models, skills, available });

const general = {
	name: "General",
	description: "d",
	instructions: "",
	default: true,
};
const other = { name: "Other", description: "d", instructions: "" };

// a write reloads asynchronously in other processes
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean) {
	for (let i = 0; i < 50; i++) {
		const value = await read();
		if (ok(value)) return value;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timed out");
}

describe.skipIf(!url)("@orqestra/agents writes (Postgres)", () => {
	// leaves only a default Agent, as the baseline does, also for the next package's tests
	const reset = async () => {
		await db.execute(
			sql`truncate provider, enabled_model, agent, skill cascade`,
		);
		await agents.save({ id: "general", create: true, definition: general });
	};
	beforeEach(reset);
	afterAll(async () => {
		await reset();
		await Promise.all([agents.close(), models.close(), skills.close()]);
		await db.$client.end();
	});

	describe("Skills", () => {
		const skillZip = (name: string, description: string) =>
			zip([
				{
					path: `${name}/SKILL.md`,
					content: `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`,
				},
			]);

		it("is removed from every Agent Definition when deleted", async () => {
			await skills.upload(skillZip("pdf", "d"), false);
			await skills.upload(skillZip("doc", "d"), false);
			await agents.save({
				id: "general",
				create: false,
				definition: { ...general, skills: ["pdf", "doc"] },
			});
			await agents.save({
				id: "other",
				create: true,
				definition: { ...other, skills: ["pdf"] },
			});
			await agents.deleteSkill("pdf");
			const { agents: listed } = await agents.list();
			expect(listed.map((a) => [a.id, a.definition.skills])).toEqual([
				["general", ["doc"]],
				["other", []],
			]);
			expect((await skills.list()).map((s) => s.name)).toEqual(["doc"]);
		});
	});

	describe("Agent Definitions", () => {
		it("lets a new default Agent take over from the old one", async () => {
			await agents.save({
				id: "other",
				create: true,
				definition: { ...other, default: true },
			});
			const { agents: listed } = await agents.list();
			expect(listed.map((a) => [a.id, a.definition.default])).toEqual([
				["general", false],
				["other", true],
			]);
			expect((await agents.current()).defaultAgent.id).toBe("other");
		});

		it("refuses to delete the default Agent or to unset it", async () => {
			await expect(agents.delete("general")).rejects.toThrow(
				/default Agent cannot be deleted/,
			);
			expect(
				await agents.save({
					id: "general",
					create: false,
					definition: { ...general, default: false },
				}),
			).toEqual({ errors: { default: { code: "default_required" } } });
		});

		it("returns invalid fields as codes, keeping zod's message as detail", async () => {
			const { errors } = await agents.save({
				id: "x",
				create: true,
				definition: { ...other, name: "" },
			});
			expect(errors).toEqual({
				name: { code: "invalid", detail: expect.any(String) },
			});
			expect(
				(
					await agents.save({
						id: "general",
						create: true,
						definition: general,
					})
				).errors,
			).toEqual({ id: { code: "id_taken" } });
			expect(
				(
					await agents.save({
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
		const elsewhere = createAgents(db, { models, skills, available });
		try {
			expect((await elsewhere.current()).agents.map((a) => a.id)).toEqual([
				"general",
			]);
			await agents.save({
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
