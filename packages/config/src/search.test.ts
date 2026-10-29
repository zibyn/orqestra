import { afterEach, describe, expect, it, vi } from "vitest";
import { scrape, search } from "./search";

/** Stubs fetch with one JSON response and records the request. */
function respond(body: unknown, status = 200) {
	const fetch = vi.fn(
		async (_url: string, _init: RequestInit) =>
			new Response(JSON.stringify(body), { status }),
	);
	vi.stubGlobal("fetch", fetch);
	return () => {
		const [url, init] = fetch.mock.calls[0];
		return {
			url,
			auth: new Headers(init.headers).get("authorization"),
			body: JSON.parse(init.body as string),
		};
	};
}

afterEach(() => vi.unstubAllGlobals());

const page = { title: "Pi", url: "https://pi.dev", snippet: "An agent" };

describe("search", () => {
	it("asks Tavily for `count` results", async () => {
		const request = respond({
			results: [{ title: "Pi", url: "https://pi.dev", content: "An agent" }],
		});
		expect(await search({ provider: "tavily", apiKey: "k" }, "pi", 3)).toEqual([
			page,
		]);
		expect(request()).toEqual({
			url: "https://api.tavily.com/search",
			auth: "Bearer k",
			body: { query: "pi", max_results: 3 },
		});
	});

	it("asks Firecrawl for `count` web results", async () => {
		const request = respond({
			success: true,
			data: {
				web: [{ title: "Pi", url: "https://pi.dev", description: "An agent" }],
			},
		});
		expect(
			await search({ provider: "firecrawl", apiKey: "k" }, "pi", 3),
		).toEqual([page]);
		expect(request()).toMatchObject({
			url: "https://api.firecrawl.dev/v2/search",
			body: { query: "pi", limit: 3 },
		});
	});

	it("asks DeepSeek for `count` results", async () => {
		const request = respond({ results: [page] });
		expect(
			await search({ provider: "deepseek", apiKey: "k" }, "pi", 3),
		).toEqual([page]);
		expect(request()).toEqual({
			url: "https://api.deepseek.com/v1/tools/search",
			auth: "Bearer k",
			body: { query: "pi", count: 3 },
		});
	});

	it("fails with the service's status and message", async () => {
		respond({ error: "bad key" }, 401);
		await expect(
			search({ provider: "tavily", apiKey: "k" }, "pi", 3),
		).rejects.toThrow(/Tavily.*401.*bad key/);
	});
});

describe("scrape", () => {
	it("reads a page as Markdown through Tavily", async () => {
		const request = respond({
			results: [{ url: "https://pi.dev", raw_content: "# Pi" }],
		});
		expect(
			await scrape({ provider: "tavily", apiKey: "k" }, "https://pi.dev"),
		).toBe("# Pi");
		expect(request()).toMatchObject({
			url: "https://api.tavily.com/extract",
			body: { urls: ["https://pi.dev"], format: "markdown" },
		});
	});

	it("reads a page as Markdown through Firecrawl", async () => {
		const request = respond({ success: true, data: { markdown: "# Pi" } });
		expect(
			await scrape({ provider: "firecrawl", apiKey: "k" }, "https://pi.dev"),
		).toBe("# Pi");
		expect(request()).toMatchObject({
			url: "https://api.firecrawl.dev/v2/scrape",
			body: { url: "https://pi.dev", formats: ["markdown"] },
		});
	});

	it("reads a page as Markdown through DeepSeek", async () => {
		const request = respond({ title: "Pi", content: "# Pi" });
		expect(
			await scrape({ provider: "deepseek", apiKey: "k" }, "https://pi.dev"),
		).toBe("# Pi");
		expect(request()).toMatchObject({
			url: "https://api.deepseek.com/v1/tools/fetch",
			body: { url: "https://pi.dev" },
		});
	});

	it("fails when the page has no content", async () => {
		respond({ results: [], failed_results: [{ url: "https://pi.dev" }] });
		await expect(
			scrape({ provider: "tavily", apiKey: "k" }, "https://pi.dev"),
		).rejects.toThrow(/no content/);
	});
});
