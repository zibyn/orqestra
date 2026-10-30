import { describe, expect, it } from "bun:test";
import {
	type Context,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai";
import { generateTitle } from "./title.ts";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
const models = createModels();
models.setProvider(faux.provider);
const streamSimple = models.streamSimple.bind(models);
const model = faux.getModel();

const question = { role: "user" as const, content: "hi", timestamp: 1 };
const answer = fauxAssistantMessage("Hello there");
const titled = (reply: ReturnType<typeof fauxAssistantMessage>) => {
	faux.setResponses([reply]);
	return generateTitle(question, answer, model, streamSimple);
};

describe("generateTitle", () => {
	it("asks the model for a title of the question and its answer", async () => {
		let seen: Context | undefined;
		faux.setResponses([
			(context) => {
				seen = context;
				return fauxAssistantMessage("A greeting");
			},
		]);
		expect(await generateTitle(question, answer, model, streamSimple)).toBe(
			"A greeting",
		);
		expect(JSON.stringify(seen)).toContain("at most 20 characters");
		expect(JSON.stringify(seen?.messages)).toContain(
			"User: hi\\n\\nAssistant: Hello there",
		);
	});

	it("drops surrounding quotes and cuts it to 20 characters", async () => {
		expect(await titled(fauxAssistantMessage(" “A greeting” "))).toBe(
			"A greeting",
		);
		expect(await titled(fauxAssistantMessage("「问候」"))).toBe("问候");
		expect(
			await titled(
				fauxAssistantMessage("一二三四五六七八九十一二三四五六七八九十多"),
			),
		).toBe("一二三四五六七八九十一二三四五六七八九十");
	});

	it("gives none unless the model finished its reply", async () => {
		expect(
			await titled(fauxAssistantMessage("Cut", { stopReason: "length" })),
		).toBeUndefined();
		expect(await titled(fauxAssistantMessage("  "))).toBeUndefined();
	});
});
