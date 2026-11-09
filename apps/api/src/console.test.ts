import { describe, expect, it } from "bun:test";
import type { Conversations } from "@orqestra/conversations";
import { createApp, type User } from "./app.ts";

const admin = { id: "a1", name: "Ada", admin: true };
const member = { id: "m1", name: "Max", admin: false };

const app = (user: User | null) => {
	const api = createApp({
		session: async () => ({ user, cookies: [] }),
		auth: () => new Response(null, { status: 404 }),
		conversations: {} as Conversations,
	});
	// handle needs its app as this
	return (request: Request) => api.handle(request);
};

const request = (method: string, path: string, body?: unknown) =>
	new Request(`http://localhost${path}`, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

// every console endpoint, each with a body that passes validation
const endpoints: [string, string, unknown?][] = [
	["GET", "/api/providers"],
	["POST", "/api/providers", { id: "openai", baseUrl: "https://x.test" }],
	[
		"POST",
		"/api/providers/test",
		{ id: "openai", baseUrl: "https://x.test", modelId: "m" },
	],
	["DELETE", "/api/providers/openai"],
	[
		"PUT",
		"/api/providers/models",
		{ providerId: "openai", modelId: "m", enabled: true },
	],
	["GET", "/api/search-providers"],
	[
		"POST",
		"/api/search-providers",
		{ id: "tavily", baseUrl: "https://x.test" },
	],
	["DELETE", "/api/search-providers/tavily"],
	["PUT", "/api/search-providers/tools", { tool: "search", provider: null }],
	["GET", "/api/mcp-servers"],
	[
		"POST",
		"/api/mcp-servers",
		{
			id: "docs",
			create: true,
			name: "Docs",
			url: "https://x.test",
			enabled: true,
			headers: [],
		},
	],
	["PUT", "/api/mcp-servers/enabled", { id: "docs", enabled: false }],
	["DELETE", "/api/mcp-servers/docs"],
	["GET", "/api/sandbox-provider"],
	[
		"POST",
		"/api/sandbox-provider",
		{ url: "https://x.test", snapshot: "", cpu: 1, memory: 1024 },
	],
	["DELETE", "/api/sandbox-provider"],
	["GET", "/api/agents"],
	["POST", "/api/agents", { id: "general", create: true, definition: {} }],
	["DELETE", "/api/agents/general"],
];

describe("console endpoints", () => {
	for (const [method, path, body] of endpoints) {
		it(`${method} ${path} is 401 without a User`, async () => {
			const response = await app(null)(request(method, path, body));
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({
				errors: { session: { code: "unauthorized" } },
			});
		});

		it(`${method} ${path} is 403 for a Member`, async () => {
			const response = await app(member)(request(method, path, body));
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				errors: { session: { code: "forbidden" } },
			});
		});
	}

	// checked before the body, so a request that is not allowed learns nothing of the fields
	it("is 401 or 403 before invalid input is validated", async () => {
		for (const [user, status] of [
			[null, 401],
			[member, 403],
		] as const)
			for (const [method, path, body] of [
				["POST", "/api/providers", { id: 1 }],
				["PUT", "/api/skills/x/current", {}],
				["POST", "/api/messages", {}],
				["PUT", "/api/memories", {}],
			] as const) {
				// Members may use their Conversations and Memories
				if (user && !path.match(/providers|skills/)) continue;
				const response = await app(user)(request(method, path, body));
				expect([path, response.status]).toEqual([path, status]);
			}
	});

	it("is 422 with the field's code for invalid input", async () => {
		const response = await app(admin)(
			request("POST", "/api/providers", { id: "openai", baseUrl: "ftp://x" }),
		);
		expect(response.status).toBe(422);
		const { errors } = (await response.json()) as {
			errors: Record<string, { code: string }>;
		};
		expect(Object.keys(errors)).toEqual(["baseUrl"]);
		expect(errors.baseUrl?.code).toBe("invalid");
	});
});
