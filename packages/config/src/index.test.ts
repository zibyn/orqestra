import { afterEach, describe, expect, it, vi } from "vitest";
import {
	catalogProviders,
	GENERAL_WORKER,
	loadConfig,
	resolveThinking,
	resolveTurn,
	type Settings,
} from "./index";

const general = {
	name: "General",
	description: "Helps with anything",
	instructions: "You are a helpful assistant.",
	default: true,
};
const agentWith = (fields: Record<string, unknown>) => ({
	name: "G",
	description: "d",
	instructions: "hi",
	default: true,
	...fields,
});

const deepseek = (
	enabled = ["deepseek-flash", "deepseek-v4-pro"],
	provider: Partial<Settings["providers"][number]> = {},
	agents: Record<string, unknown> = { general },
): Settings => ({
	providers: [
		{ id: "deepseek", apiKey: "sk-test", baseUrl: null, ...provider },
	],
	enabledModels: enabled.map((id) => `deepseek/${id}`),
	agents: Object.entries(agents).map(([id, definition]) => ({
		id,
		definition,
	})),
	searchProviders: [],
	servedBy: { search: null, scrape: null },
	mcpServers: [],
});
const withAgents = (agents: Record<string, unknown>, enabled?: string[]) =>
	deepseek(enabled, {}, agents);

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
		const config = await loadConfig(deepseek());
		expect(config.defaultAgent).toMatchObject({
			id: "general",
			name: "General",
			description: "Helps with anything",
			instructions: "You are a helpful assistant.",
			defaultModel: "deepseek/deepseek-flash",
			unavailableModels: [],
			pickable: true,
			allModels: true,
			tools: ["search", "scrape"],
		});
	});

	it("allows every enabled Model when `models` is omitted", async () => {
		const config = await loadConfig(deepseek(["deepseek-v4-pro"]));
		// disabled Models and Providers nobody configured stay out
		expect(config.defaultAgent.models).toEqual(["deepseek/deepseek-v4-pro"]);
		expect(config.defaultAgent.defaultModel).toBe("deepseek/deepseek-v4-pro");
	});

	it("sends a Provider's Models to its custom baseUrl, keeping the Catalog's compat", async () => {
		const config = await loadConfig(
			deepseek(["deepseek-flash"], { baseUrl: "http://10.0.0.1:8080" }),
		);
		expect(config.models[0]).toMatchObject({
			baseUrl: "http://10.0.0.1:8080",
			compat: { thinkingFormat: "deepseek" },
		});
	});

	describe("Models an Agent references but that are not available", () => {
		it("drops them with a warning instead of failing", async () => {
			const config = await loadConfig(
				withAgents(
					{
						general: agentWith({
							models: [
								"deepseek/deepseek-flash",
								"deepseek/deepseek-v4-pro",
								"deepseek/gone",
							],
						}),
					},
					["deepseek-flash"],
				),
			);
			expect(config.defaultAgent.models).toEqual(["deepseek/deepseek-flash"]);
			expect(config.defaultAgent.unavailableModels).toEqual([
				"deepseek/deepseek-v4-pro",
				"deepseek/gone",
			]);
		});

		it("falls back to the first remaining Model when the default is gone", async () => {
			const config = await loadConfig(
				withAgents(
					{
						general: agentWith({
							models: ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"],
						}),
					},
					["deepseek-flash"],
				),
			);
			expect(config.defaultAgent.defaultModel).toBe("deepseek/deepseek-flash");
		});

		it("takes the Agent offline when none are left", async () => {
			const config = await loadConfig(deepseek([]));
			expect(config.defaultAgent.models).toEqual([]);
			expect(resolveTurn(config, "general")).toBeUndefined();
		});
	});

	it("fails a request to a Provider whose API key cannot be decrypted", async () => {
		const config = await loadConfig(
			deepseek(["deepseek-flash"], { apiKey: undefined }),
		);
		expect(() =>
			config.streamSimple(config.models[0], { messages: [] }),
		).toThrow(/API key of Provider "deepseek" cannot be decrypted/);
	});

	describe("Tools", () => {
		const settings = (
			servedBy: Settings["servedBy"],
			searchProviders: Settings["searchProviders"],
		) => ({ ...deepseek(), servedBy, searchProviders });

		it("serves each Tool from the Search Provider picked for it", async () => {
			const config = await loadConfig(
				settings({ search: "tavily", scrape: "deepseek" }, [
					{ id: "tavily", apiKey: "tv", baseUrl: null },
					{ id: "deepseek", apiKey: "ds", baseUrl: "https://ds.example.com" },
				]),
			);
			// no baseUrl: the official one
			expect(config.tools).toEqual({
				search: {
					provider: "tavily",
					apiKey: "tv",
					baseUrl: "https://api.tavily.com",
				},
				scrape: {
					provider: "deepseek",
					apiKey: "ds",
					baseUrl: "https://ds.example.com",
				},
			});
		});

		it("leaves a Tool unavailable when its Search Provider is not picked, deleted or has an unreadable key", async () => {
			const config = await loadConfig(
				settings({ search: "firecrawl", scrape: "tavily" }, [
					{ id: "tavily", apiKey: undefined, baseUrl: null },
				]),
			);
			expect(config.tools).toEqual({});
			expect(
				(await loadConfig(settings({ search: null, scrape: null }, []))).tools,
			).toEqual({});
		});

		it("offers enabled MCP Servers by id, with their headers decrypted", async () => {
			const config = await loadConfig({
				...deepseek(),
				mcpServers: [
					{
						id: "github",
						name: "GitHub",
						url: "https://mcp.example.com/mcp",
						enabled: true,
						headers: [{ name: "Authorization", value: "Bearer gh" }],
					},
					{
						id: "wiki",
						name: "Wiki",
						url: "http://10.0.0.2/mcp",
						enabled: true,
						headers: [],
					},
				],
			});
			expect(config.mcpServers).toEqual({
				github: {
					name: "GitHub",
					url: "https://mcp.example.com/mcp",
					headers: { Authorization: "Bearer gh" },
				},
				wiki: { name: "Wiki", url: "http://10.0.0.2/mcp", headers: {} },
			});
		});

		it("leaves an MCP Server unavailable when it is disabled or a header cannot be decrypted", async () => {
			const server = {
				name: "S",
				url: "https://mcp.example.com/mcp",
				enabled: true,
				headers: [{ name: "X-Token", value: "t" }],
			};
			const config = await loadConfig({
				...deepseek(),
				mcpServers: [
					{ ...server, id: "off", enabled: false },
					{
						...server,
						id: "unreadable",
						headers: [
							{ name: "X-Token", value: "t" },
							{ name: "X-Other", value: undefined },
						],
					},
				],
			});
			expect(config.mcpServers).toEqual({});
		});

		it("keeps an Agent's `tools` as written", async () => {
			const config = await loadConfig(
				withAgents({ general: agentWith({ tools: ["scrape"] }) }),
			);
			expect(config.defaultAgent.tools).toEqual(["scrape"]);
		});
	});

	it("tells Agents with and without their own Models apart", async () => {
		const config = await loadConfig(
			withAgents({
				general,
				pinned: agentWith({
					default: false,
					pickable: false,
					models: ["deepseek/deepseek-v4-pro"],
				}),
			}),
		);
		expect(config.agents.find((a) => a.id === "pinned")).toMatchObject({
			allModels: false,
			pickable: false,
		});
	});

	describe("rejects invalid configuration", () => {
		const fails = async (agents: Record<string, unknown>, pattern: RegExp) => {
			vi.stubEnv("ORQESTRA_DEFAULT_MODEL", "deepseek/deepseek-flash");
			await expect(loadConfig(withAgents(agents))).rejects.toThrow(pattern);
		};

		it("a defaultModel outside `models`", () =>
			fails(
				{
					general: agentWith({
						models: ["deepseek/deepseek-flash"],
						defaultModel: "deepseek/deepseek-v4-pro",
					}),
				},
				/Agent "general": defaultModel/,
			));

		it("no default Agent", () =>
			fails(
				{ general: { ...general, default: false } },
				/exactly one Agent must be the default \(found none\)/,
			));

		it("two default Agents", () =>
			fails(
				{ general, other: general },
				/exactly one Agent must be the default \(found general, other\)/,
			));

		it("a default Agent Users cannot pick", () =>
			fails(
				{ general: { ...general, pickable: false } },
				/Agent "general": pickable/,
			));

		it("a missing name", () =>
			fails({ general: { ...general, name: undefined } }, /"general": name/));

		it("a field the definition does not know, such as a user", () =>
			fails({ general: { ...general, userId: "u1" } }, /"general": .*userId/));

		it("an unknown thinking level", () =>
			fails(
				{ general: agentWith({ thinking: { default: "huge" } }) },
				/"general": thinking\.default/,
			));

		it("an unknown Tool", () =>
			fails(
				{ general: agentWith({ tools: ["search", "browse"] }) },
				/"general": tools\.1/,
			));

		it("a non-positive compaction budget", () =>
			fails(
				{ general: agentWith({ compaction: { reserveTokens: 0 } }) },
				/"general": compaction\.reserveTokens/,
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
	const load = () =>
		loadConfig(
			withAgents({
				general: agentWith({
					models: ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
				}),
			}),
		);

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

	it("runs a Subagent without a template as the general worker, on the picked Model and every Tool", async () => {
		const turn = resolveTurn(await load(), null, {
			model: "deepseek/deepseek-v4-pro",
		});
		expect(turn?.model.id).toBe("deepseek-v4-pro");
		expect(turn?.agent.instructions).toBe(GENERAL_WORKER);
		expect(turn?.agent.tools).toEqual(["search", "scrape"]);
	});

	it("returns nothing once the Agent is removed from config, so the Conversation is read-only", async () => {
		expect(resolveTurn(await load(), "deleted-agent")).toBeUndefined();
	});
});
