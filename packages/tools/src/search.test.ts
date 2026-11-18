import { describe, expect, it } from "vitest";
import { builtinTools, type ToolService } from "./index.ts";
import type { SearchProviderId, ToolName } from "./shared.ts";

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
	const tools = builtinTools({ tools: { [name]: service } }, [name], { fetch });
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`no ${name} Tool`);
	const result = await tool.execute("1", params as never, never);
	const [content] = result.content;
	return content.type === "text" ? content.text : "";
}

const listed = "## Pi\nhttps://pi.dev\n\nAn agent";

describe("search", () => {
	it("lists each result's title, URL and snippet, asking for `count` of them", async () => {
		const { fetch, request } = respond({
			results: [{ title: "Pi", url: "https://pi.dev", content: "An agent" }],
		});
		expect(
			await call("search", official("tavily"), fetch, {
				query: "pi",
				count: 3,
			}),
		).toBe(listed);
		expect(request().body).toEqual({ query: "pi", max_results: 3 });
	});

	it("asks for 5 results by default and says when there are none", async () => {
		const { fetch, request } = respond({ results: [] });
		expect(
			await call("search", official("tavily"), fetch, { query: "pi" }),
		).toBe("No results.");
		expect(request().body).toEqual({ query: "pi", max_results: 5 });
	});
});

// one answer each Search Provider's client reads as no results, or as the page "# Pi"
const anyProvider = {
	results: [{ raw_content: "# Pi" }],
	data: { web: [], markdown: "# Pi" },
	content: "# Pi",
};

describe.each([
	["tavily", "https://api.tavily.com/search", "https://api.tavily.com/extract"],
	[
		"firecrawl",
		"https://api.firecrawl.dev/v2/search",
		"https://api.firecrawl.dev/v2/scrape",
	],
	[
		"deepseek",
		"https://api.deepseek.com/v1/tools/search",
		"https://api.deepseek.com/v1/tools/fetch",
	],
] as const)("served by %s", (provider, searchUrl, scrapeUrl) => {
	it("asks that Search Provider, with its key", async () => {
		let r = respond({ ...anyProvider, results: [] });
		await call("search", official(provider), r.fetch, { query: "pi" });
		expect(r.request()).toMatchObject({ url: searchUrl, auth: "Bearer k" });
		r = respond(anyProvider);
		expect(
			await call("scrape", official(provider), r.fetch, {
				url: "https://pi.dev",
			}),
		).toBe("# Pi");
		expect(r.request()).toMatchObject({ url: scrapeUrl, auth: "Bearer k" });
	});
});

describe("scrape", () => {
	it("cuts a long page with the same notice as any Tool result", async () => {
		const { fetch } = respond({ content: "a".repeat(60_000) });
		expect(
			await call("scrape", official("deepseek"), fetch, {
				url: "https://pi.dev",
			}),
		).toBe(`${"a".repeat(50_000)}\n\n[The result was cut off here.]`);
	});
});

describe("builtinTools", () => {
	it("offers only the built-in Tools the Agent allows that have a Search Provider", () => {
		const box = builtinTools(
			{ tools: { search: official("tavily") } },
			["search", "scrape"],
			{},
		);
		expect(box.map((t) => t.name)).toEqual(["search"]);
		const none = builtinTools(
			{ tools: { search: official("tavily") } },
			["scrape"],
			{},
		);
		expect(none).toEqual([]);
	});
});
