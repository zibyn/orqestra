import { describe, expect, it } from "vitest";
import { m } from "#/paraglide/messages";
import { errorText } from "./save-errors";

/** An error as Eden throws it for a refused api call. */
const eden = (status: number, errors: unknown) =>
	Object.assign(new Error(String(errors)), { status, value: { errors } });

describe("errorText", () => {
	it("translates the first field error of an api error", () => {
		expect(errorText(eden(404, { path: { code: "not_found" } }))).toBe(
			m.save_not_found(),
		);
		expect(
			errorText(eden(422, { "": { code: "invalid", detail: "Too long." } })),
		).toBe("Too long.");
	});

	it("falls back to a generic text for a code it does not know", () => {
		expect(errorText(eden(401, { session: { code: "unauthorized" } }))).toBe(
			m.request_failed(),
		);
	});

	it("shows a plain Error's message", () => {
		expect(errorText(new Error("Offline"))).toBe("Offline");
	});
});
