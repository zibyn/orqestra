import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	catalogProviders,
	loadConfig,
	type ModelSettings,
	resolveThinking,
	resolveTurn,
} from "./index";

const deepseek = (
	enabled = ["deepseek-flash", "deepseek-v4-pro"],
	provider: Partial<ModelSettings["providers"][number]> = {},
): ModelSettings => ({
	providers: [
		{ id: "deepseek", apiKey: "sk-test", baseUrl: null, ...provider },
	],
	enabledModels: enabled.map((id) => `deepseek/${id}`),
});

function configDir(agents: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), "orqestra-config-"));
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
const agentWith = (frontmatter: string) =>
	`---\nname: G\ndescription: d\ndefault: true\n${frontmatter}\n---\nhi`;

afterEach(() => vi.unstubAllEnvs());

describe("catalogProviders", () => {
	it("lists Providers that work with one API key and a fixed baseUrl", async () => {
		const ids = (await catalogProviders()).map((p) => p.id);
		expect(ids).toEqual(expect.arrayContaining(["deepseek", "anthropic"]));
		for (const id of [
			"amazon-bedrock",
			"google-vertex",
			"azure",
			"cloudflare-ai-gateway",
			"cloudflare-workers-ai",
			"github-copilot",
			"openai-codex",
		])
			expect(ids).not.toContain(id);
	});
});

describe("loadConfig", () => {
	it("loads an Agent Definition with its instructions", async () => {
		vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-flash");
		const config = await loadConfig(deepseek(), configDir({ general }));
		expect(config.defaultAgent).toMatchObject({
			id: "general",
			name: "General",
			description: "Helps with anything",
			instructions: "You are a helpful assistant.",
			defaultModel: "deepseek/deepseek-flash",
			unavailableModels: [],
		});
	});

	it("allows every enabled Model when `models` is omitted", async () => {
		const config = await loadConfig(
			deepseek(["deepseek-v4-pro"]),
			configDir({ general }),
		);
		// disabled Models and Providers nobody configured stay out
		expect(config.defaultAgent.models).toEqual(["deepseek/deepseek-v4-pro"]);
		expect(config.defaultAgent.defaultModel).toBe("deepseek/deepseek-v4-pro");
	});

	it("sends a Provider's Models to its custom baseUrl, keeping the Catalog's compat", async () => {
		const config = await loadConfig(
			deepseek(["deepseek-flash"], { baseUrl: "http://10.0.0.1:8080" }),
			configDir({ general }),
		);
		expect(config.models[0]).toMatchObject({
			baseUrl: "http://10.0.0.1:8080",
			compat: { thinkingFormat: "deepseek" },
		});
	});

	describe("Models an Agent references but that are not available", () => {
		it("drops them with a warning instead of failing", async () => {
			const config = await loadConfig(
				deepseek(["deepseek-flash"]),
				configDir({
					general: agentWith(
						"models: [deepseek/deepseek-flash, deepseek/deepseek-v4-pro, deepseek/gone]",
					),
				}),
			);
			expect(config.defaultAgent.models).toEqual(["deepseek/deepseek-flash"]);
			expect(config.defaultAgent.unavailableModels).toEqual([
				"deepseek/deepseek-v4-pro",
				"deepseek/gone",
			]);
		});

		it("falls back to the first remaining Model when the default is gone", async () => {
			const config = await loadConfig(
				deepseek(["deepseek-flash"]),
				configDir({
					general: agentWith(
						"models: [deepseek/deepseek-v4-pro, deepseek/deepseek-flash]",
					),
				}),
			);
			expect(config.defaultAgent.defaultModel).toBe("deepseek/deepseek-flash");
		});

		it("takes the Agent offline when none are left", async () => {
			const config = await loadConfig(
				{ providers: [], enabledModels: [] },
				configDir({ general }),
			);
			expect(config.defaultAgent.models).toEqual([]);
			expect(resolveTurn(config, "general")).toBeUndefined();
		});
	});

	it("fails a request to a Provider whose API key cannot be decrypted", async () => {
		const config = await loadConfig(
			deepseek(["deepseek-flash"], { apiKey: undefined }),
			configDir({ general }),
		);
		expect(() =>
			config.streamSimple(config.models[0], { messages: [] }),
		).toThrow(/API key of Provider "deepseek" cannot be decrypted/);
	});

	describe("rejects invalid configuration", () => {
		const fails = async (agents: Record<string, string>, pattern: RegExp) => {
			vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-flash");
			await expect(loadConfig(deepseek(), configDir(agents))).rejects.toThrow(
				pattern,
			);
		};

		it("a defaultModel outside `models`", () =>
			fails(
				{
					general: agentWith(
						"models: [deepseek/deepseek-flash]\ndefaultModel: deepseek/deepseek-v4-pro",
					),
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

describe("resolveTurn", () => {
	const twoModels = `---\nname: G\ndescription: d\ndefault: true\nmodels: [deepseek/deepseek-flash, deepseek/deepseek-v4-pro]\n---\nhi`;
	const load = () => loadConfig(deepseek(), configDir({ general: twoModels }));

	it("uses the Agent's default Model and thinking level when nothing is picked", async () => {
		const turn = resolveTurn(await load(), "general");
		expect(turn?.model.id).toBe("deepseek-flash");
		expect(turn?.thinking).toBe("low");
		expect(turn?.agent.id).toBe("general");
	});

	it("keeps an allowed Model and thinking level picked for the message", async () => {
		const turn = resolveTurn(await load(), "general", {
			model: "deepseek/deepseek-v4-pro",
			thinking: "max",
		});
		expect(turn?.model.id).toBe("deepseek-v4-pro");
		expect(turn?.thinking).toBe("max");
	});

	it("falls back to the default Model once the picked one leaves the allowed list", async () => {
		const turn = resolveTurn(await load(), "general", {
			model: "deepseek/removed-model",
			thinking: "high",
		});
		expect(turn?.model.id).toBe("deepseek-flash");
		expect(turn?.thinking).toBe("high");
	});

	it("falls back to the Model's default level when the picked one is not offered", async () => {
		const turn = resolveTurn(await load(), "general", {
			model: "deepseek/deepseek-v4-pro",
			thinking: "low",
		});
		expect(turn?.thinking).toBe("high");
	});

	it("returns nothing once the Agent is removed from config, so the Conversation is read-only", async () => {
		expect(resolveTurn(await load(), "deleted-agent")).toBeUndefined();
	});
});
