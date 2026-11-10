import { expect, test } from "vitest";
import {
	describeCron,
	fromWallClock,
	nextFirings,
	wallClock,
} from "./next-firing";

const now = new Date("2026-03-04T10:20:00Z");

test("a one-time schedule fires at its time", () => {
	expect(
		nextFirings({ kind: "once", at: "2026-03-05T08:00:00Z" }, "UTC", 1, now),
	).toEqual([new Date("2026-03-05T08:00:00Z")]);
});

test("an interval fires at its next multiples since the epoch, as BullMQ aligns it", () => {
	expect(nextFirings({ kind: "every", seconds: 3600 }, "UTC", 2, now)).toEqual([
		new Date("2026-03-04T11:00:00Z"),
		new Date("2026-03-04T12:00:00Z"),
	]);
});

test("a cron expression fires next in the time zone given; an invalid one has no next Firing", () => {
	expect(
		nextFirings({ kind: "cron", expr: "0 9 * * *" }, "Asia/Shanghai", 2, now),
	).toEqual([
		new Date("2026-03-05T01:00:00Z"),
		new Date("2026-03-06T01:00:00Z"),
	]);
	expect(nextFirings({ kind: "cron", expr: "nope" }, "UTC", 1, now)).toEqual(
		[],
	);
});

test("a cron expression reads as words in the User's language; an invalid one has none", () => {
	expect(describeCron("0 9 * * 1-5", "zh")).toBe("在09:00, 星期一至星期五");
	expect(describeCron("0 9 * * 1-5", "en")).toBe(
		"At 09:00, Monday through Friday",
	);
	expect(describeCron("nope", "en")).toBeUndefined();
});

test("a time entered on the clocks of the task's time zone is that zone's, not the browser's", () => {
	expect(fromWallClock("2026-03-05T09:00", "Asia/Shanghai")).toEqual(
		new Date("2026-03-05T01:00:00Z"),
	);
	expect(wallClock(new Date("2026-03-05T01:00:00Z"), "Asia/Shanghai")).toBe(
		"2026-03-05T09:00",
	);
});

test("either side of a DST change, the zone's offset of that day applies", () => {
	// New York moves from UTC-5 to UTC-4 on 2026-03-08
	expect(fromWallClock("2026-03-07T09:00", "America/New_York")).toEqual(
		new Date("2026-03-07T14:00:00Z"),
	);
	expect(fromWallClock("2026-03-09T09:00", "America/New_York")).toEqual(
		new Date("2026-03-09T13:00:00Z"),
	);
});
