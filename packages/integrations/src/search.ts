// What the Search Providers' clients share: each directory maps its API onto `search` and `scrape`, sent here as JSON POSTs.
import type { Fetch, SearchClient, SearchResult } from "./ports.ts";

// biome-ignore lint/suspicious/noExplicitAny: each service's JSON, read field by field
type Post = (path: string, body: unknown) => Promise<any>;

/** One Search Provider's API. */
export interface SearchApi {
	search(post: Post, query: string, count: number): Promise<SearchResult[]>;
	/** The page as Markdown; empty or undefined when there is none. */
	scrape(post: Post, url: string): Promise<string | undefined>;
}

/** The client of Search Provider `name`, whose API `api` maps: given its key and address, the official one or another. */
export const searchClient =
	(name: string, api: SearchApi) =>
	(
		{ apiKey, baseUrl }: { apiKey: string; baseUrl: string },
		fetch: Fetch,
	): SearchClient => {
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
						`${name} answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
					);
				return response.json();
			};
		return {
			search: (query, count, signal) => api.search(post(signal), query, count),
			scrape: async (url, signal) => {
				const markdown = await api.scrape(post(signal), url);
				if (!markdown) throw new Error(`${url} returned no content`);
				return markdown;
			},
		};
	};
