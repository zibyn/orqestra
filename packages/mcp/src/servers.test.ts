import { describe, expect, it } from "vitest";
import { mcpServerInput, resolveMcpServers } from "./servers.ts";

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

describe("a Git Host as an Admin enters it", () => {
	const input = (git: Partial<Record<string, string>>) =>
		mcpServerInput.safeParse({
			id: "github",
			create: true,
			name: "GitHub",
			url: "https://api.githubcopilot.com/mcp/",
			enabled: true,
			headers: [],
			git: {
				host: "github.com",
				username: "x-access-token",
				tokenEnv: "GH_TOKEN",
				...git,
			},
		}).success;

	it("takes a host, with a port, a username and an environment variable", () => {
		expect(input({})).toBe(true);
		expect(input({ host: "gitea.internal:3000", username: "oauth2" })).toBe(
			true,
		);
	});

	it("refuses what would break out of the credential helper or clash with orrery's and git's own variables", () => {
		for (const git of [
			{ host: "github.com; rm x" },
			{ host: "https://github.com" },
			{ username: "x;echo" },
			{ username: "" },
			{ tokenEnv: "PATH" },
			{ tokenEnv: "LD_PRELOAD" },
			{ tokenEnv: "ORRERY_TOKEN" },
			{ tokenEnv: "GIT_CONFIG_COUNT" },
			{ tokenEnv: "gh token" },
		])
			expect(input(git)).toBe(false);
	});
});
