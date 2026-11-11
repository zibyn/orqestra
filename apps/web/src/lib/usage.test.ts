import { expect, test } from "vitest";
import { resetDate, usageRange } from "./usage";

// the browser's time zone draws the days
process.env.TZ = "Asia/Shanghai";
const now = new Date("2026-03-01T01:00:00+08:00");
const iso = (r: { from: string; to: string }) => [r.from, r.to];

test("today is the browser's day so far, up to its end", () => {
	expect(iso(usageRange("today", now))).toEqual([
		"2026-02-28T16:00:00.000Z",
		"2026-03-01T16:00:00.000Z",
	]);
});

test("the last 7 and 30 days end with today", () => {
	expect(usageRange("7d", now).from).toBe("2026-02-22T16:00:00.000Z");
	expect(usageRange("30d", now).from).toBe("2026-01-30T16:00:00.000Z");
	expect(usageRange("30d", now).to).toBe("2026-03-01T16:00:00.000Z");
});

test("this month runs from its 1st to the next month's", () => {
	expect(iso(usageRange("month", now))).toEqual([
		"2026-02-28T16:00:00.000Z",
		"2026-03-31T16:00:00.000Z",
	]);
});

test("a custom range covers both its days", () => {
	expect(
		iso(usageRange({ from: "2026-02-10", to: "2026-02-11" }, now)),
	).toEqual(["2026-02-09T16:00:00.000Z", "2026-02-11T16:00:00.000Z"]);
});

test("a Spending Limit resets on the 1st where its reset time zone has it, not the browser", () => {
	// midnight on 1 December in Auckland is still 30 November in Shanghai
	expect(
		resetDate(
			{
				resetsAt: "2026-11-30T11:00:00.000Z",
				resetTimeZone: "Pacific/Auckland",
			},
			"en-US",
		),
	).toBe("December 1");
});
