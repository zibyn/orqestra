import { describe, expect, it } from "vitest";
import { invokedSkill, parseSkillBlock, skillBlock } from "./shared.ts";

describe("a message that invokes a Skill", () => {
	it("reads back as the Skill's name and the User's own text", () => {
		expect(
			parseSkillBlock(
				skillBlock("pdf", "Use pypdf.\n\n</skill>?", "merge them"),
			),
		).toEqual({ name: "pdf", text: "merge them" });
		expect(parseSkillBlock(skillBlock("pdf", "Use pypdf.", ""))).toEqual({
			name: "pdf",
			text: "",
		});
	});

	it("is any other message when written by hand", () => {
		expect(parseSkillBlock('<skill name="pdf">hi</skill>')).toBeUndefined();
		expect(parseSkillBlock("/skill:pdf merge them")).toBeUndefined();
	});
});

describe("a User's text that invokes a Skill", () => {
	it("names the Skill and what follows it", () => {
		expect(invokedSkill("/skill:pdf  merge\nthem ")).toEqual({
			name: "pdf",
			args: "merge\nthem",
		});
		expect(invokedSkill("/skill:pdf")).toEqual({ name: "pdf", args: "" });
	});

	it("is none unless the text starts with /skill:", () => {
		expect(invokedSkill("use /skill:pdf")).toBeUndefined();
		expect(invokedSkill("/skill:")).toBeUndefined();
	});
});
