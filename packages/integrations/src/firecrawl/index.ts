// Firecrawl's v2 Search and Scrape APIs.
import { searchClient } from "../search.ts";

export const firecrawl = searchClient("Firecrawl", {
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
});
