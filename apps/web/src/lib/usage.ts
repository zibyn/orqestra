export type UsagePreset = "today" | "7d" | "30d" | "month";
/** A custom range: two days as an `<input type="date">` gives them, both included. */
export type CustomRange = { from: string; to: string };

/** The instants a Usage range starts and ends at, its days drawn in the browser's time zone. */
export function usageRange(range: UsagePreset | CustomRange, now = new Date()) {
	const day = (y: number, m: number, d: number) =>
		new Date(y, m, d).toISOString();
	if (typeof range === "object") {
		const [fy, fm, fd] = range.from.split("-").map(Number);
		const [ty, tm, td] = range.to.split("-").map(Number);
		return { from: day(fy, fm - 1, fd), to: day(ty, tm - 1, td + 1) };
	}
	const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
	if (range === "month") return { from: day(y, m, 1), to: day(y, m + 1, 1) };
	const back = { today: 0, "7d": 6, "30d": 29 }[range];
	return { from: day(y, m, d - back), to: day(y, m, d + 1) };
}
