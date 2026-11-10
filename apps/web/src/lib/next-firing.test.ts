import { expect, test } from "vitest";
import { nextFiring } from "./next-firing";

const now = new Date("2026-03-04T10:20:00Z");

test("a one-time schedule fires at its time", () => {
	expect(
		nextFiring({ kind: "once", at: "2026-03-05T08:00:00Z" }, "UTC", now),
	).toEqual(new Date("2026-03-05T08:00:00Z"));
});

test("an interval fires at its next multiple since the epoch, as BullMQ aligns it", () => {
	expect(nextFiring({ kind: "every", seconds: 3600 }, "UTC", now)).toEqual(
		new Date("2026-03-04T11:00:00Z"),
	);
});

test("a cron expression fires next in the time zone given; an invalid one has no next Firing", () => {
	expect(
		nextFiring({ kind: "cron", expr: "0 9 * * *" }, "Asia/Shanghai", now),
	).toEqual(new Date("2026-03-05T01:00:00Z"));
	expect(
		nextFiring({ kind: "cron", expr: "nope" }, "UTC", now),
	).toBeUndefined();
});
