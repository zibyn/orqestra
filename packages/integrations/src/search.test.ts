import { describe, expect, it } from "vitest";
import { deepseek } from "./deepseek/index.ts";
import { firecrawl } from "./firecrawl/index.ts";
import { tavily } from "./tavily/index.ts";

// the official endpoints, as when the Admin leaves baseUrl blank
const official = {
	tavily: { apiKey: "k", baseUrl: "https://api.tavily.com" },
	firecrawl: { apiKey: "k", baseUrl: "https://api.firecrawl.dev" },
	deepseek: { apiKey: "k", baseUrl: "https://api.deepseek.com" },
};

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

const found = [{ title: "Pi", url: "https://pi.dev", snippet: "An agent" }];

describe("search", () => {
	it("asks Tavily for `count` results", async () => {
		const { fetch, request } = respond({
			results: [{ title: "Pi", url: "https://pi.dev", content: "An agent" }],
		});
		expect(await tavily(official.tavily, fetch).search("pi", 3)).toEqual(found);
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
		expect(await firecrawl(official.firecrawl, fetch).search("pi", 3)).toEqual(
			found,
		);
		expect(request()).toMatchObject({
			url: "https://api.firecrawl.dev/v2/search",
			body: { query: "pi", limit: 3 },
		});
	});

	it("asks DeepSeek for `count` results", async () => {
		const { fetch, request } = respond({
			results: [{ title: "Pi", url: "https://pi.dev", snippet: "An agent" }],
		});
		expect(await deepseek(official.deepseek, fetch).search("pi", 3)).toEqual(
			found,
		);
		expect(request()).toEqual({
			url: "https://api.deepseek.com/v1/tools/search",
			auth: "Bearer k",
			body: { query: "pi", count: 3 },
		});
	});

	it("fails with the service's status and message", async () => {
		const { fetch } = respond({ error: "bad key" }, 401);
		await expect(
			tavily(official.tavily, fetch).search("pi", 5),
		).rejects.toThrow(/Tavily.*401.*bad key/);
	});
});

describe("a custom baseUrl (self-hosted, or behind a reverse proxy)", () => {
	it("replaces the official one for Search and Scrape", async () => {
		const service = { apiKey: "k", baseUrl: "http://firecrawl.local:3002/" };
		let r = respond({ success: true, data: { web: [] } });
		await firecrawl(service, r.fetch).search("pi", 3);
		expect(r.request().url).toBe("http://firecrawl.local:3002/v2/search");
		r = respond({ success: true, data: { markdown: "# Pi" } });
		await firecrawl(service, r.fetch).scrape("https://pi.dev");
		expect(r.request().url).toBe("http://firecrawl.local:3002/v2/scrape");
	});
});

describe("scrape", () => {
	it("reads a page as Markdown through Tavily", async () => {
		const { fetch, request } = respond({
			results: [{ url: "https://pi.dev", raw_content: "# Pi" }],
		});
		expect(await tavily(official.tavily, fetch).scrape("https://pi.dev")).toBe(
			"# Pi",
		);
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
			await firecrawl(official.firecrawl, fetch).scrape("https://pi.dev"),
		).toBe("# Pi");
		expect(request()).toMatchObject({
			url: "https://api.firecrawl.dev/v2/scrape",
			body: { url: "https://pi.dev", formats: ["markdown"] },
		});
	});

	it("reads a page as Markdown through DeepSeek", async () => {
		const { fetch, request } = respond({ title: "Pi", content: "# Pi" });
		expect(
			await deepseek(official.deepseek, fetch).scrape("https://pi.dev"),
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
			tavily(official.tavily, fetch).scrape("https://pi.dev"),
		).rejects.toThrow(/no content/);
	});
});
