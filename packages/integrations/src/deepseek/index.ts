// DeepSeek's search and fetch tools.
import { searchClient } from "../search.ts";

export const deepseek = searchClient("DeepSeek", {
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
	scrape: async (post, url) => (await post("/v1/tools/fetch", { url })).content,
});
