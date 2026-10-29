import type { ToolService } from "./index.ts";
import { searchProviders } from "./shared.ts";

// Search and Scrape through the Search Providers' HTTP APIs; only the parameters all of them share are exposed.

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

async function post(
	{ provider, apiKey }: ToolService,
	url: string,
	body: unknown,
	signal?: AbortSignal,
	// biome-ignore lint/suspicious/noExplicitAny: each service's JSON, read field by field
): Promise<any> {
	const response = await fetch(url, {
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
	if (!response.ok) {
		const name = searchProviders.find((p) => p.id === provider)?.name;
		throw new Error(
			`${name} answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
		);
	}
	return response.json();
}

export async function search(
	tool: ToolService,
	query: string,
	count: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (tool.provider === "tavily") {
		const data = await post(
			tool,
			"https://api.tavily.com/search",
			{ query, max_results: count },
			signal,
		);
		return data.results.map(
			(r: { title: string; url: string; content: string }) => ({
				title: r.title,
				url: r.url,
				snippet: r.content,
			}),
		);
	}
	if (tool.provider === "firecrawl") {
		const data = await post(
			tool,
			"https://api.firecrawl.dev/v2/search",
			{ query, limit: count },
			signal,
		);
		return (data.data?.web ?? []).map(
			(r: { title: string; url: string; description: string }) => ({
				title: r.title,
				url: r.url,
				snippet: r.description,
			}),
		);
	}
	const data = await post(
		tool,
		"https://api.deepseek.com/v1/tools/search",
		{ query, count },
		signal,
	);
	// shortcut: field names from DeepSeek's launch docs (2026-10); recheck if results come back empty
	return data.results.map(
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
	);
}

/** One page as Markdown. */
export async function scrape(
	tool: ToolService,
	url: string,
	signal?: AbortSignal,
): Promise<string> {
	let markdown: string | undefined;
	if (tool.provider === "tavily")
		markdown = (
			await post(
				tool,
				"https://api.tavily.com/extract",
				{ urls: [url], format: "markdown" },
				signal,
			)
		).results[0]?.raw_content;
	else if (tool.provider === "firecrawl")
		markdown = (
			await post(
				tool,
				"https://api.firecrawl.dev/v2/scrape",
				{ url, formats: ["markdown"] },
				signal,
			)
		).data?.markdown;
	else
		markdown = (
			await post(
				tool,
				"https://api.deepseek.com/v1/tools/fetch",
				{ url },
				signal,
			)
		).content;
	if (!markdown) throw new Error(`${url} returned no content`);
	return markdown;
}
