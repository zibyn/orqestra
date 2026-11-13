import { type ModelSettings, resolveModels } from "@orqestra/models";
import { describe, expect, it } from "vitest";
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
/** The Models and Agents side by side, as a process's snapshot holds them. */
const loadConfig = async ({
	agents,
	sandboxProvider,
	...settings
}: Settings) => {
	const models = await resolveModels(settings);
	return { ...models, ...resolveAgents(agents), sandboxProvider };
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

describe("loadConfig", () => {
	it("loads an Agent Definition with its instructions", async () => {
		const config = await loadConfig(deepseek());
		expect(config.defaultAgent).toEqual({
			id: "general",
			name: "General",
			description: "Helps with anything",
			instructions: "You are a helpful assistant.",
			pickable: true,
			default: true,
			tools: ["search", "scrape"],
			skills: [],
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

	describe("rejects invalid configuration", () => {
		const fails = async (agents: Record<string, unknown>, pattern: RegExp) => {
			await expect(loadConfig(withAgents(agents))).rejects.toThrow(pattern);
		};

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

		it("a Model, thinking level, memory or compaction, which are not the Agent's", () =>
			fails(
				{
					general: agentWith({
						models: ["deepseek/deepseek-flash"],
						defaultModel: "deepseek/deepseek-flash",
						thinking: { default: "low" },
						memory: true,
						compaction: { reserveTokens: 1000 },
					}),
				},
				/"general": models, defaultModel, thinking, memory, compaction/,
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
	});
});

describe("resolveTurn", () => {
	const load = (defaultModel?: string) =>
		loadConfig({ ...deepseek(), defaultModel });

	it("uses the first enabled Model and its default thinking level when nothing is marked or picked", async () => {
		const turn = resolveTurn(await load(), "general");
		expect(turn?.model.id).toBe("deepseek-flash");
		expect(turn?.thinking).toBe("low");
		expect(turn?.agent.id).toBe("general");
	});

	it("uses the Model an Admin marked as the default", async () => {
		const turn = resolveTurn(await load("deepseek/deepseek-v4-pro"), "general");
		expect(turn?.model.id).toBe("deepseek-v4-pro");
		expect(turn?.defaultModel.id).toBe("deepseek-v4-pro");
	});

	it("keeps any enabled Model and thinking level picked for the message", async () => {
		const turn = resolveTurn(await load(), "general", {
			model: "deepseek/deepseek-v4-pro",
			thinking: "max",
		});
		expect(turn?.model.id).toBe("deepseek-v4-pro");
		expect(turn?.thinking).toBe("max");
		// the Conversation's title comes from the default Model, whatever was picked
		expect(turn?.defaultModel.id).toBe("deepseek-flash");
	});

	it("falls back to the default Model once the picked one is no longer enabled", async () => {
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

	it("returns nothing once the Agent is removed or no Model is enabled, so the Conversation is read-only", async () => {
		expect(resolveTurn(await load(), "deleted-agent")).toBeUndefined();
		expect(
			resolveTurn(await loadConfig(deepseek([])), "general"),
		).toBeUndefined();
	});
});
