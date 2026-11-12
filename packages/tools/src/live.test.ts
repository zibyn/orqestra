import { describe, expect, it } from "vitest";
import { loadTools, type ToolSettings } from "./live.ts";

const none: ToolSettings = {
	searchProviders: [],
	servedBy: { search: null, scrape: null },
};
const settings = (
	servedBy: ToolSettings["servedBy"],
	searchProviders: ToolSettings["searchProviders"],
) => ({ ...none, servedBy, searchProviders });

describe("loadTools", () => {
	it("serves each Tool from the Search Provider picked for it", async () => {
		const config = await loadTools(
			settings({ search: "tavily", scrape: "deepseek" }, [
				{ id: "tavily", apiKey: "tv", baseUrl: null },
				{ id: "deepseek", apiKey: "ds", baseUrl: "https://ds.example.com" },
			]),
		);
		// no baseUrl: the official one
		expect(config.tools).toEqual({
			search: {
				provider: "tavily",
				apiKey: "tv",
				baseUrl: "https://api.tavily.com",
			},
			scrape: {
				provider: "deepseek",
				apiKey: "ds",
				baseUrl: "https://ds.example.com",
			},
		});
	});

	it("leaves a Tool unavailable when its Search Provider is not picked, deleted or has an unreadable key", async () => {
		const config = await loadTools(
			settings({ search: "firecrawl", scrape: "tavily" }, [
				{ id: "tavily", apiKey: undefined, baseUrl: null },
			]),
		);
		expect(config.tools).toEqual({});
		expect(
			(await loadTools(settings({ search: null, scrape: null }, []))).tools,
		).toEqual({});
	});

	it("offers the Sandbox Provider with its token decrypted, on orrery's default Snapshot when none is set", async () => {
		const stored = {
			url: "http://orrery.internal",
			token: "orr_1_s",
			snapshot: null,
			cpu: 2,
			memory: 2147483648,
		};
		expect((await loadTools(none)).sandboxProvider).toBeUndefined();
		expect(
			(await loadTools({ ...none, sandboxProvider: stored })).sandboxProvider,
		).toEqual({
			url: "http://orrery.internal",
			token: "orr_1_s",
			snapshot: undefined,
			cpu: 2,
			memory: 2147483648,
		});
		expect(
			(
				await loadTools({
					...none,
					sandboxProvider: { ...stored, snapshot: "skills" },
				})
			).sandboxProvider?.snapshot,
		).toBe("skills");
	});

	it("leaves the Sandbox Provider unavailable when its token cannot be decrypted", async () => {
		const config = await loadTools({
			...none,
			sandboxProvider: {
				url: "http://orrery.internal",
				token: undefined,
				snapshot: null,
				cpu: 2,
				memory: 2147483648,
			},
		});
		expect(config.sandboxProvider).toBeUndefined();
	});
});
