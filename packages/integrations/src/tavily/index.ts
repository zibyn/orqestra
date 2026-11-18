// Tavily's Search and Extract APIs.
import { searchClient } from "../search.ts";

export const tavily = searchClient("Tavily", {
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
});
