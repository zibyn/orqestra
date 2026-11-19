// What the console shows of the outside systems: no Node imports, so browser code can use this module (as @orqestra/integrations/shared)

/** The Search Providers Orqestra supports, with their official baseUrl; each can be configured at most once. */
export const searchProviders = [
	{ id: "tavily", name: "Tavily", baseUrl: "https://api.tavily.com" },
	{ id: "firecrawl", name: "Firecrawl", baseUrl: "https://api.firecrawl.dev" },
	{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" },
] as const;
export type SearchProviderId = (typeof searchProviders)[number]["id"];

/** The Document Parser's address until an Admin types another: mineru.net's online service. */
export const MINERU_URL = "https://mineru.net";
/** mineru.net's online service, whose API (v4) needs a key; any other address is a self-hosted MinerU. */
export const isMineruNet = (url: string) =>
	URL.parse(url)?.hostname === "mineru.net";
