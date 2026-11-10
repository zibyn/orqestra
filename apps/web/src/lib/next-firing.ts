import { CronExpressionParser } from "cron-parser";

type Schedule =
	| { kind: "once"; at: string }
	| { kind: "every"; seconds: number }
	| { kind: "cron"; expr: string };

/** When a schedule fires next after `after`, as the worker would schedule it; none for an invalid cron expression. */
export function nextFiring(
	schedule: Schedule,
	timeZone: string,
	after = new Date(),
) {
	if (schedule.kind === "once") return new Date(schedule.at);
	if (schedule.kind === "every") {
		// BullMQ aligns `every` to the epoch
		const every = schedule.seconds * 1000;
		return new Date(Math.floor(after.getTime() / every) * every + every);
	}
	try {
		return CronExpressionParser.parse(schedule.expr, {
			currentDate: after,
			tz: timeZone,
		})
			.next()
			.toDate();
	} catch {
		return undefined;
	}
}
