import { describe, expect, it } from "vitest";
import { availableTools } from "./index.ts";

const tavily = {
	provider: "tavily",
	apiKey: "k",
	baseUrl: "https://x",
} as const;
const server = (name: string) => ({ name, url: "https://x/mcp", headers: {} });

describe("availableTools", () => {
	it("lists the built-in Tools with a Search Provider, then every MCP Server's Tools", () => {
		expect(
			availableTools({
				tools: { scrape: tavily },
				mcpServers: { github: server("GitHub"), wiki: server("Wiki") },
			}),
		).toEqual(["scrape", "mcp:github", "mcp:wiki"]);
	});

	it("keeps the built-in Tools in their fixed order", () => {
		expect(
			availableTools({
				tools: { scrape: tavily, search: tavily },
				mcpServers: {},
			}),
		).toEqual(["search", "scrape"]);
	});
});
