import { describe, expect, it } from "vitest";
import { resolveMcpServers } from "./servers.ts";

describe("resolveMcpServers", () => {
	describe("Tools", () => {
		it("offers enabled MCP Servers by id, with their headers decrypted", () => {
			const config = resolveMcpServers([
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
			]);
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

		it("leaves an MCP Server unavailable when it is disabled or a header cannot be decrypted", () => {
			const server = {
				name: "S",
				url: "https://mcp.example.com/mcp",
				enabled: true,
				auth: "shared" as const,
				headers: [{ name: "X-Token", value: "t" }],
			};
			const config = resolveMcpServers([
				{ ...server, id: "off", enabled: false },
				{
					...server,
					id: "unreadable",
					headers: [
						{ name: "X-Token", value: "t" },
						{ name: "X-Other", value: undefined },
					],
				},
			]);
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
	});
});
