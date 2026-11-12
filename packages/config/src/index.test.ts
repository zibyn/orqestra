import { describe, expect, it } from "vitest";
import { loadConfig, type Settings } from "./index";

const deepseek = (): Settings => ({
	providers: [{ id: "deepseek", apiKey: "sk-test", baseUrl: null }],
	enabledModels: ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"],
	modelPrices: {},
	searchProviders: [],
	servedBy: { search: null, scrape: null },
	mcpServers: [],
});

describe("loadConfig", () => {
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
						auth: "shared",
						headers: [{ name: "Authorization", value: "Bearer gh" }],
					},
					{
						id: "wiki",
						name: "Wiki",
						url: "http://10.0.0.2/mcp",
						enabled: true,
						auth: "oauth",
						headers: [],
					},
				],
			});
			expect(config.mcpServers).toEqual({
				github: {
					name: "GitHub",
					url: "https://mcp.example.com/mcp",
					auth: "shared",
					headers: { Authorization: "Bearer gh" },
				},
				// left to each Run, by its User's Connection
				wiki: {
					name: "Wiki",
					url: "http://10.0.0.2/mcp",
					auth: "oauth",
					headers: {},
				},
			});
		});

		it("leaves an MCP Server unavailable when it is disabled or a header cannot be decrypted", async () => {
			const server = {
				name: "S",
				url: "https://mcp.example.com/mcp",
				enabled: true,
				auth: "shared" as const,
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
			// kept, so deleting it can still cancel its calls
			expect(config.allMcpServers).toEqual({
				off: {
					name: "S",
					url: "https://mcp.example.com/mcp",
					auth: "shared",
					headers: { "X-Token": "t" },
				},
			});
		});

		it("offers the Sandbox Provider with its token decrypted, on orrery's default Snapshot when none is set", async () => {
			const stored = {
				url: "http://orrery.internal",
				token: "orr_1_s",
				snapshot: null,
				cpu: 2,
				memory: 2147483648,
			};
			expect((await loadConfig(deepseek())).sandboxProvider).toBeUndefined();
			expect(
				(await loadConfig({ ...deepseek(), sandboxProvider: stored }))
					.sandboxProvider,
			).toEqual({
				url: "http://orrery.internal",
				token: "orr_1_s",
				snapshot: undefined,
				cpu: 2,
				memory: 2147483648,
			});
			expect(
				(
					await loadConfig({
						...deepseek(),
						sandboxProvider: { ...stored, snapshot: "skills" },
					})
				).sandboxProvider?.snapshot,
			).toBe("skills");
		});

		it("leaves the Sandbox Provider unavailable when its token cannot be decrypted", async () => {
			const config = await loadConfig({
				...deepseek(),
				sandboxProvider: {
					url: "http://orrery.internal",
					token: undefined,
					snapshot: null,
					cpu: 2,
					memory: 2147483648,
				},
			});
			expect(config.sandboxProvider).toBeUndefined();
		});
	});
});
