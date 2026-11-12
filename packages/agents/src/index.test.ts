import { type ModelSettings, resolveModels } from "@orqestra/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GENERAL_WORKER,
	resolveAgents,
	resolveTurn,
	turnSkills,
} from "./index";

/** Stored Models and Agent Definitions; Agents ignore the MCP Servers, and the Sandbox Provider is only passed on to `turnSkills`. */
type Settings = ModelSettings & {
	agents: { id: string; definition: unknown }[];
	mcpServers?: unknown[];
	sandboxProvider?: unknown;
};
/** The Agents resolved against the Models, as a process's snapshot holds them. */
const loadConfig = async ({
	agents,
	sandboxProvider,
	...settings
}: Settings) => {
	const models = await resolveModels(settings);
	return { ...models, ...resolveAgents(agents, models), sandboxProvider };
};

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
	modelPrices: {},
	agents: Object.entries(agents).map(([id, definition]) => ({
		id,
		definition,
	})),
});
const withAgents = (agents: Record<string, unknown>, enabled?: string[]) =>
	deepseek(enabled, {}, agents);

afterEach(() => vi.unstubAllEnvs());

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
			memory: false,
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

	describe("Tools", () => {
		it("keeps an Agent's `tools` as written", async () => {
			const config = await loadConfig(
				withAgents({ general: agentWith({ tools: ["scrape"] }) }),
			);
			expect(config.defaultAgent.tools).toEqual(["scrape"]);
		});

		it("keeps `mcp:<id>` as written, even for an MCP Server that is not configured", async () => {
			const config = await loadConfig(
				withAgents({
					general: agentWith({ tools: ["search", "mcp:github", "mcp:gone"] }),
				}),
			);
			expect(config.defaultAgent.tools).toEqual([
				"search",
				"mcp:github",
				"mcp:gone",
			]);
		});

		it("gives an Agent without `tools` Search and Scrape, but not Parse and no MCP Server", async () => {
			const config = await loadConfig({
				...deepseek(),
				mcpServers: [
					{
						id: "github",
						name: "GitHub",
						url: "https://mcp.example.com/mcp",
						enabled: true,
						auth: "shared",
						headers: [],
					},
				],
			});
			expect(config.defaultAgent.tools).toEqual(["search", "scrape"]);
		});
	});

	describe("Skills", () => {
		const skill = (name: string) => ({
			versionId: 1,
			description: `${name} things`,
			disableModelInvocation: false,
		});
		const orrery = {
			url: "http://orrery.internal",
			token: "orr_1_s",
			snapshot: null,
			cpu: 2,
			memory: 2147483648,
		};
		const load = async (sandboxProvider?: Settings["sandboxProvider"]) => ({
			...(await loadConfig({
				...withAgents({
					general: agentWith({ skills: ["pdf", "off", "gone"] }),
					template: agentWith({
						default: false,
						pickable: false,
						skills: ["off"],
					}),
					plain: agentWith({ default: false }),
				}),
				sandboxProvider,
			})),
			// the Skills' snapshot: "off" is disabled
			skills: { pdf: skill("pdf"), unused: skill("unused") },
		});

		it("keeps an Agent's `skills` as written, none when omitted", async () => {
			const config = await load(orrery);
			expect(config.agents.map((a) => [a.id, a.skills])).toEqual([
				["general", ["pdf", "off", "gone"]],
				["template", ["off"]],
				["plain", []],
			]);
		});

		it("offers a Run only the enabled Skills the Agent allows", async () => {
			const config = await load(orrery);
			expect(turnSkills(config, config.defaultAgent)).toEqual([
				{
					name: "pdf",
					versionId: 1,
					description: "pdf things",
					disableModelInvocation: false,
				},
			]);
		});

		it("offers none without a Sandbox Provider", async () => {
			const config = await load();
			expect(turnSkills(config, config.defaultAgent)).toEqual([]);
		});

		it("gives the general worker no Skill, a Subagent from a template the template's", async () => {
			const config = await load(orrery);
			expect(resolveTurn(config, null)?.agent.skills).toEqual([]);
			expect(resolveTurn(config, "template")?.agent.skills).toEqual(["off"]);
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

		it("a malformed MCP Server entry", () =>
			fails(
				{ general: agentWith({ tools: ["search", "mcp:Not Valid"] }) },
				/"general": tools\.1/,
			));

		it("a non-positive compaction budget", () =>
			fails(
				{ general: agentWith({ compaction: { reserveTokens: 0 } }) },
				/"general": compaction\.reserveTokens/,
			));
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
		// the Conversation's title comes from the Agent's default Model, whatever was picked
		expect(turn?.defaultModel.id).toBe("deepseek-flash");
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

	it("runs a Subagent without a template as the general worker, on the picked Model, Search and Scrape but neither Parse nor an MCP Server", async () => {
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
