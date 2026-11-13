import { describe, expect, it } from "vitest";
import {
	catalogProviders,
	type ModelSettings,
	resolveModels,
	resolveThinking,
} from "./index";

const deepseek = (
	enabled = ["deepseek-flash", "deepseek-v4-pro"],
	provider: Partial<ModelSettings["providers"][number]> = {},
): ModelSettings => ({
	providers: [
		{ id: "deepseek", apiKey: "sk-test", baseUrl: null, ...provider },
	],
	enabledModels: enabled.map((id) => `deepseek/${id}`),
	modelPrices: {},
});

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

describe("resolveModels", () => {
	it("sends a Provider's Models to its custom baseUrl, keeping the Catalog's compat", async () => {
		const models = await resolveModels(
			deepseek(["deepseek-flash"], { baseUrl: "http://10.0.0.1:8080" }),
		);
		expect(models.models[0]).toMatchObject({
			baseUrl: "http://10.0.0.1:8080",
			compat: { thinkingFormat: "deepseek" },
		});
	});

	it("fails a request to a Provider whose API key cannot be decrypted", async () => {
		const models = await resolveModels(
			deepseek(["deepseek-flash"], { apiKey: undefined }),
		);
		expect(() =>
			models.streamSimple(models.models[0], { messages: [] }),
		).toThrow(/API key of Provider "deepseek" cannot be decrypted/);
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
		expect(resolveThinking(flash)).toEqual({
			allowed: ["off", "low", "high", "max"],
			default: "low",
		});
	});

	it("defaults to the lowest supported level when low is unsupported", () => {
		expect(resolveThinking(proOnly)).toEqual({
			allowed: ["off", "high", "max"],
			default: "high",
		});
	});

	it("only offers off for a Model without reasoning", () => {
		expect(resolveThinking({ reasoning: false })).toEqual({
			allowed: ["off"],
			default: "off",
		});
	});
});
