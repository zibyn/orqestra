import type { McpFetch } from "@earendil-works/pi-mcp";
import type { SearchProviderId, ToolService } from "./index.ts";

// Search and Scrape through the Search Providers' HTTP APIs; only the parameters all of them share are exposed.

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

// biome-ignore lint/suspicious/noExplicitAny: each service's JSON, read field by field
type Post = (path: string, body: unknown) => Promise<any>;

interface Adapter {
	name: string;
	search(post: Post, query: string, count: number): Promise<SearchResult[]>;
	/** The page as Markdown; empty or undefined when there is none. */
	scrape(post: Post, url: string): Promise<string | undefined>;
}

const adapters: Record<SearchProviderId, Adapter> = {
	tavily: {
		name: "Tavily",
		search: async (post, query, count) =>
			(await post("/search", { query, max_results: count })).results.map(
				(r: { title: string; url: string; content: string }) => ({
					title: r.title,
					url: r.url,
					snippet: r.content,
				}),
			),
		scrape: async (post, url) =>
			(await post("/extract", { urls: [url], format: "markdown" })).results[0]
				?.raw_content,
	},
	firecrawl: {
		name: "Firecrawl",
		search: async (post, query, count) =>
			((await post("/v2/search", { query, limit: count })).data?.web ?? []).map(
				(r: { title: string; url: string; description: string }) => ({
					title: r.title,
					url: r.url,
					snippet: r.description,
				}),
			),
		scrape: async (post, url) =>
			(await post("/v2/scrape", { url, formats: ["markdown"] })).data?.markdown,
	},
	deepseek: {
		name: "DeepSeek",
		// shortcut: field names from DeepSeek's launch docs (2026-10); recheck if results come back empty
		search: async (post, query, count) =>
			(await post("/v1/tools/search", { query, count })).results.map(
				(r: {
					title: string;
					url: string;
					snippet?: string;
					summary?: string;
				}) => ({
					title: r.title,
					url: r.url,
					snippet: r.snippet ?? r.summary ?? "",
				}),
			),
		scrape: async (post, url) =>
			(await post("/v1/tools/fetch", { url })).content,
	},
};

/** Search and Scrape through `service`. */
export function searchProvider(
	{ provider, apiKey, baseUrl }: ToolService,
	fetch: McpFetch,
) {
	const adapter = adapters[provider];
	const post =
		(signal?: AbortSignal): Post =>
		async (path, body) => {
			const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
				// a hung Search Provider must not hold the Run until someone stops it
				signal: AbortSignal.any([
					AbortSignal.timeout(60_000),
					...(signal ? [signal] : []),
				]),
			});
			if (!response.ok)
				throw new Error(
					`${adapter.name} answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
				);
			return response.json();
		};
	return {
		search: (query: string, count: number, signal?: AbortSignal) =>
			adapter.search(post(signal), query, count),
		/** One page as Markdown. */
		scrape: async (url: string, signal?: AbortSignal) => {
			const markdown = await adapter.scrape(post(signal), url);
			if (!markdown) throw new Error(`${url} returned no content`);
			return markdown as string;
		},
	};
}
