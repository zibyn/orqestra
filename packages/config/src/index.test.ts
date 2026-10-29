import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resolveThinking } from "./index";

const deepseekOnly = {
	providers: { deepseek: { apiKey: "$DEEPSEEK_API_KEY" } },
};

function configDir(
	agents: Record<string, string>,
	models: unknown = deepseekOnly,
) {
	const dir = mkdtempSync(join(tmpdir(), "orqestra-config-"));
	if (models !== null)
		writeFileSync(join(dir, "models.json"), JSON.stringify(models));
	mkdirSync(join(dir, "agents"));
	for (const [id, text] of Object.entries(agents))
		writeFileSync(join(dir, "agents", `${id}.md`), text);
	return dir;
}

const general = `---
name: General
description: Helps with anything
default: true
---
You are a helpful assistant.
`;

afterEach(() => vi.unstubAllEnvs());

describe("loadConfig", () => {
	it("loads an Agent Definition with its instructions", async () => {
		vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-flash");
		const config = await loadConfig(configDir({ general }));
		expect(config.defaultAgent).toMatchObject({
			id: "general",
			name: "General",
			description: "Helps with anything",
			instructions: "You are a helpful assistant.",
			defaultModel: "deepseek/deepseek-flash",
		});
	});

	it("allows every configured Model when `models` is omitted", async () => {
		vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-flash");
		const config = await loadConfig(configDir({ general }));
		expect(config.defaultAgent.models).toContain("deepseek/deepseek-flash");
		expect(config.defaultAgent.models).toContain("deepseek/deepseek-v4-pro");
		// built-in providers that models.json does not configure stay out
		expect(
			config.defaultAgent.models.every((m) => m.startsWith("deepseek/")),
		).toBe(true);
	});

	it("reports each Provider's key status without its value", async () => {
		vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-flash");
		vi.stubEnv("DEEPSEEK_API_KEY", "sk-secret");
		const config = await loadConfig(configDir({ general }));
		expect(config.providers).toEqual([
			{ id: "deepseek", name: expect.any(String), keyConfigured: true },
		]);
		expect(JSON.stringify(config.providers)).not.toContain("sk-secret");
	});

	describe("default Model fallback", () => {
		it("prefers defaultModel", async () => {
			const config = await loadConfig(
				configDir({
					general: `---\nname: G\ndescription: d\ndefault: true\nmodels: [deepseek/deepseek-flash, deepseek/deepseek-v4-pro]\ndefaultModel: deepseek/deepseek-v4-pro\n---\nhi`,
				}),
			);
			expect(config.defaultAgent.defaultModel).toBe("deepseek/deepseek-v4-pro");
		});

		it("falls back to models[0]", async () => {
			vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-flash");
			const config = await loadConfig(
				configDir({
					general: `---\nname: G\ndescription: d\ndefault: true\nmodels: [deepseek/deepseek-v4-pro]\n---\nhi`,
				}),
			);
			expect(config.defaultAgent.defaultModel).toBe("deepseek/deepseek-v4-pro");
		});

		it("falls back to ORQESTRA_DEFAULT_MODEL", async () => {
			vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-v4-pro");
			const config = await loadConfig(configDir({ general }));
			expect(config.defaultAgent.defaultModel).toBe("deepseek/deepseek-v4-pro");
		});

		it("fails when there is nothing to fall back to", async () => {
			vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "");
			await expect(loadConfig(configDir({ general }))).rejects.toThrow(
				/general\.md: defaultModel/,
			);
		});
	});

	describe("rejects invalid configuration", () => {
		const fails = async (
			agents: Record<string, string>,
			pattern: RegExp,
			models?: unknown,
		) => {
			vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-flash");
			await expect(
				loadConfig(configDir(agents, models ?? deepseekOnly)),
			).rejects.toThrow(pattern);
		};

		it("a missing models.json", async () => {
			vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-flash");
			await expect(loadConfig(configDir({ general }, null))).rejects.toThrow(
				/models\.json/,
			);
		});

		it("a literal API key", () =>
			fails({ general }, /models\.json: providers\.deepseek\.apiKey/, {
				providers: { deepseek: { apiKey: "sk-123" } },
			}));

		it("a shell-command API key", () =>
			fails({ general }, /models\.json: providers\.deepseek\.apiKey/, {
				providers: { deepseek: { apiKey: "!cat key" } },
			}));

		it("a models.json pi rejects", () =>
			fails({ general }, /models\.json/, { providers: { deepseek: 3 } }));

		it("a reference to an unknown Model", () =>
			fails(
				{
					general: `---\nname: G\ndescription: d\ndefault: true\nmodels: [deepseek/nope]\n---\nhi`,
				},
				/general\.md: models\.0: unknown Model "deepseek\/nope"/,
			));

		it("a Model from a Provider not in models.json", () =>
			fails(
				{
					general: `---\nname: G\ndescription: d\ndefault: true\nmodels: [anthropic/claude-sonnet-4-5]\n---\nhi`,
				},
				/general\.md: models\.0/,
			));

		it("a defaultModel outside `models`", () =>
			fails(
				{
					general: `---\nname: G\ndescription: d\ndefault: true\nmodels: [deepseek/deepseek-flash]\ndefaultModel: deepseek/deepseek-v4-pro\n---\nhi`,
				},
				/general\.md: defaultModel/,
			));

		it("no default Agent", () =>
			fails(
				{ general: general.replace("default: true\n", "") },
				/exactly one Agent must have `default: true`/,
			));

		it("two default Agents", () =>
			fails(
				{ general, other: general },
				/exactly one Agent must have `default: true` \(found general, other\)/,
			));

		it("missing frontmatter", () =>
			fails({ general: "just text" }, /general\.md: missing YAML frontmatter/));

		it("malformed YAML", () =>
			fails(
				{ general: "---\nname: [oops\n---\nhi" },
				/general\.md: invalid YAML/,
			));

		it("a missing name", () =>
			fails(
				{ general: general.replace("name: General\n", "") },
				/general\.md: name/,
			));

		it("a field the definition does not know, such as a user", () =>
			fails(
				{
					general: general.replace(
						"default: true",
						"default: true\nuserId: u1",
					),
				},
				/general\.md: .*userId/,
			));

		it("an unknown thinking level", () =>
			fails(
				{
					general: general.replace(
						"default: true",
						"default: true\nthinking: { default: huge }",
					),
				},
				/general\.md: thinking\.default/,
			));

		it("a non-positive compaction budget", () =>
			fails(
				{
					general: general.replace(
						"default: true",
						"default: true\ncompaction: { reserveTokens: 0 }",
					),
				},
				/general\.md: compaction\.reserveTokens/,
			));
	});
});

describe("resolveThinking", () => {
	const flash = {
		reasoning: true,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			max: "max",
		},
	};
	const proOnly = {
		reasoning: true,
		thinkingLevelMap: {
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			max: "max",
		},
	};

	it("allows every level the Model supports and defaults to low", () => {
		expect(resolveThinking({}, flash)).toEqual({
			allowed: ["off", "low", "high", "max"],
			default: "low",
		});
	});

	it("defaults to the lowest supported level when low is unsupported", () => {
		expect(resolveThinking({}, proOnly)).toEqual({
			allowed: ["off", "high", "max"],
			default: "high",
		});
	});

	it("only offers off for a Model without reasoning", () => {
		expect(resolveThinking({}, { reasoning: false })).toEqual({
			allowed: ["off"],
			default: "off",
		});
	});

	it("narrows to the Agent's allowed levels the Model supports", () => {
		expect(
			resolveThinking(
				{ allowed: ["medium", "high", "max"], default: "max" },
				flash,
			),
		).toEqual({ allowed: ["high", "max"], default: "max" });
	});

	it("ignores a configured default the Model cannot use", () => {
		expect(resolveThinking({ default: "low" }, proOnly).default).toBe("high");
	});
});
