import { describe, expect, it } from "vitest";
import {
	openToolbox,
	type SearchProviderId,
	type ToolName,
	type ToolService,
} from "./index.ts";

const officialUrl = {
	tavily: "https://api.tavily.com",
	firecrawl: "https://api.firecrawl.dev",
	deepseek: "https://api.deepseek.com",
};
// the official endpoint, as when the Admin leaves baseUrl blank
const official = (provider: SearchProviderId): ToolService => ({
	provider,
	apiKey: "k",
	baseUrl: officialUrl[provider],
});

/** A fetch answering one JSON response; records the requests. */
function respond(body: unknown, status = 200) {
	const requests: { url: string; auth: string | null; body: unknown }[] = [];
	const fetch = async (url: string | URL, init?: RequestInit) => {
		requests.push({
			url: String(url),
			auth: new Headers(init?.headers).get("authorization"),
			body: JSON.parse(String(init?.body)),
		});
		return new Response(JSON.stringify(body), { status });
	};
	return { fetch, request: () => requests[0] };
}

const never = new AbortController().signal;

/** Calls built-in Tool `name`, served by `service`, and returns its text. */
async function call(
	name: ToolName,
	service: ToolService,
	fetch: ReturnType<typeof respond>["fetch"],
	params: Record<string, unknown>,
) {
	const box = await openToolbox(
		{ tools: { [name]: service }, mcpServers: {} },
		[name],
		{ signal: never, fetch },
	);
	const tool = box.tools.find((t) => t.name === name);
	if (!tool) throw new Error(`no ${name} Tool`);
	const result = await tool.execute("1", params as never, never);
	await box.close();
	const [content] = result.content;
	return content.type === "text" ? content.text : "";
}

const listed = "## Pi\nhttps://pi.dev\n\nAn agent";

describe("search", () => {
	it("asks Tavily for `count` results", async () => {
		const { fetch, request } = respond({
			results: [{ title: "Pi", url: "https://pi.dev", content: "An agent" }],
		});
		expect(
			await call("search", official("tavily"), fetch, {
				query: "pi",
				count: 3,
			}),
		).toBe(listed);
		expect(request()).toEqual({
			url: "https://api.tavily.com/search",
			auth: "Bearer k",
			body: { query: "pi", max_results: 3 },
		});
	});

	it("asks Firecrawl for `count` web results", async () => {
		const { fetch, request } = respond({
			success: true,
			data: {
				web: [{ title: "Pi", url: "https://pi.dev", description: "An agent" }],
			},
		});
		expect(
			await call("search", official("firecrawl"), fetch, {
				query: "pi",
				count: 3,
			}),
		).toBe(listed);
		expect(request()).toMatchObject({
			url: "https://api.firecrawl.dev/v2/search",
			body: { query: "pi", limit: 3 },
		});
	});

	it("asks DeepSeek for `count` results", async () => {
		const { fetch, request } = respond({
			results: [{ title: "Pi", url: "https://pi.dev", snippet: "An agent" }],
		});
		expect(
			await call("search", official("deepseek"), fetch, {
				query: "pi",
				count: 3,
			}),
		).toBe(listed);
		expect(request()).toEqual({
			url: "https://api.deepseek.com/v1/tools/search",
			auth: "Bearer k",
			body: { query: "pi", count: 3 },
		});
	});

	it("asks for 5 results by default and says when there are none", async () => {
		const { fetch, request } = respond({ results: [] });
		expect(
			await call("search", official("tavily"), fetch, { query: "pi" }),
		).toBe("No results.");
		expect(request().body).toEqual({ query: "pi", max_results: 5 });
	});

	it("fails with the service's status and message", async () => {
		const { fetch } = respond({ error: "bad key" }, 401);
		await expect(
			call("search", official("tavily"), fetch, { query: "pi" }),
		).rejects.toThrow(/Tavily.*401.*bad key/);
	});
});

describe("a custom baseUrl (self-hosted, or behind a reverse proxy)", () => {
	it("replaces the official one for Search and Scrape", async () => {
		const tool: ToolService = {
			provider: "firecrawl",
			apiKey: "k",
			baseUrl: "http://firecrawl.local:3002/",
		};
		let r = respond({ success: true, data: { web: [] } });
		await call("search", tool, r.fetch, { query: "pi", count: 3 });
		expect(r.request().url).toBe("http://firecrawl.local:3002/v2/search");
		r = respond({ success: true, data: { markdown: "# Pi" } });
		await call("scrape", tool, r.fetch, { url: "https://pi.dev" });
		expect(r.request().url).toBe("http://firecrawl.local:3002/v2/scrape");
	});
});

describe("scrape", () => {
	it("reads a page as Markdown through Tavily", async () => {
		const { fetch, request } = respond({
			results: [{ url: "https://pi.dev", raw_content: "# Pi" }],
		});
		expect(
			await call("scrape", official("tavily"), fetch, {
				url: "https://pi.dev",
			}),
		).toBe("# Pi");
		expect(request()).toMatchObject({
			url: "https://api.tavily.com/extract",
			body: { urls: ["https://pi.dev"], format: "markdown" },
		});
	});

	it("reads a page as Markdown through Firecrawl", async () => {
		const { fetch, request } = respond({
			success: true,
			data: { markdown: "# Pi" },
		});
		expect(
			await call("scrape", official("firecrawl"), fetch, {
				url: "https://pi.dev",
			}),
		).toBe("# Pi");
		expect(request()).toMatchObject({
			url: "https://api.firecrawl.dev/v2/scrape",
			body: { url: "https://pi.dev", formats: ["markdown"] },
		});
	});

	it("reads a page as Markdown through DeepSeek", async () => {
		const { fetch, request } = respond({ title: "Pi", content: "# Pi" });
		expect(
			await call("scrape", official("deepseek"), fetch, {
				url: "https://pi.dev",
			}),
		).toBe("# Pi");
		expect(request()).toMatchObject({
			url: "https://api.deepseek.com/v1/tools/fetch",
			body: { url: "https://pi.dev" },
		});
	});

	it("fails when the page has no content", async () => {
		const { fetch } = respond({
			results: [],
			failed_results: [{ url: "https://pi.dev" }],
		});
		await expect(
			call("scrape", official("tavily"), fetch, { url: "https://pi.dev" }),
		).rejects.toThrow(/no content/);
	});

	it("cuts a long page with the same notice as any Tool result", async () => {
		const { fetch } = respond({ content: "a".repeat(60_000) });
		expect(
			await call("scrape", official("deepseek"), fetch, {
				url: "https://pi.dev",
			}),
		).toBe(`${"a".repeat(50_000)}\n\n[The result was cut off here.]`);
	});
});

describe("openToolbox", () => {
	it("offers only the built-in Tools the Agent allows that have a Search Provider", async () => {
		const box = await openToolbox(
			{ tools: { search: official("tavily") }, mcpServers: {} },
			["search", "scrape"],
			{ signal: never },
		);
		expect(box.tools.map((t) => t.name)).toEqual(["search"]);
		const none = await openToolbox(
			{ tools: { search: official("tavily") }, mcpServers: {} },
			["scrape"],
			{ signal: never },
		);
		expect(none.tools).toEqual([]);
	});
});
