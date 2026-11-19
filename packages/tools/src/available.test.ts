import { describe, expect, it } from "vitest";
import { availableBuiltinTools } from "./index.ts";

const tavily = {
	provider: "tavily",
	apiKey: "k",
	baseUrl: "https://x",
} as const;

describe("availableBuiltinTools", () => {
	it("lists the built-in Tools with a Search Provider", () => {
		expect(availableBuiltinTools({ tools: { scrape: tavily } })).toEqual([
			"scrape",
		]);
	});

	it("keeps the built-in Tools in their fixed order", () => {
		expect(
			availableBuiltinTools({ tools: { scrape: tavily, search: tavily } }),
		).toEqual(["search", "scrape"]);
	});
});
