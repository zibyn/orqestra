import { expect, test } from "vitest";
import { groupSteps } from "./steps";

test("consecutive steps share a run; a text part ends it", () => {
	const t = (type: string, n = 0) => ({ type, n });
	const parts = [
		t("thinking"),
		t("tool"),
		t("text"),
		t("tool", 1),
		t("text", 1),
	];
	expect(groupSteps(parts, (p) => p.type !== "text")).toEqual([
		[t("thinking"), t("tool")],
		t("text"),
		[t("tool", 1)],
		t("text", 1),
	]);
	expect(groupSteps([], () => true)).toEqual([]);
});
