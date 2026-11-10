import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import "cronstrue/locales/zh_CN.js";

type Schedule =
	| { kind: "once"; at: string }
	| { kind: "every"; seconds: number }
	| { kind: "cron"; expr: string };

/** The next `n` Firings of a schedule after `after`, as the worker would schedule them; none for an invalid cron expression. */
export function nextFirings(
	schedule: Schedule,
	timeZone: string,
	n = 1,
	after = new Date(),
): Date[] {
	if (schedule.kind === "once") return [new Date(schedule.at)];
	if (schedule.kind === "every") {
		// BullMQ aligns `every` to the epoch
		const every = schedule.seconds * 1000;
		const first = Math.floor(after.getTime() / every) * every + every;
		return Array.from({ length: n }, (_, i) => new Date(first + i * every));
	}
	try {
		return CronExpressionParser.parse(schedule.expr, {
			currentDate: after,
			tz: timeZone,
		})
			.take(n)
			.map((d) => d.toDate());
	} catch {
		return [];
	}
}

/** A cron expression in words, in `locale` (`zh` or `en`); undefined for an invalid one. */
export function describeCron(expr: string, locale: string) {
	try {
		return cronstrue.toString(expr, {
			locale: locale === "zh" ? "zh_CN" : "en",
			use24HourTimeFormat: true,
		});
	} catch {
		return undefined;
	}
}

/** `YYYY-MM-DDTHH:mm` of a time on the clocks of `timeZone`, for a datetime-local input. */
export const wallClock = (time: Date, timeZone: string) =>
	new Intl.DateTimeFormat("sv-SE", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	})
		.format(time)
		.replace(" ", "T");

/** The time the clocks of `timeZone` show as `local` (`YYYY-MM-DDTHH:mm`). */
export function fromWallClock(local: string, timeZone: string) {
	const asUtc = new Date(`${local}Z`).getTime();
	// the zone's offset at the guess, taken twice so a DST change between the guess and the answer is caught
	let time = asUtc;
	for (let i = 0; i < 2; i++)
		time =
			asUtc -
			(new Date(`${wallClock(new Date(time), timeZone)}Z`).getTime() - time);
	return new Date(time);
}
