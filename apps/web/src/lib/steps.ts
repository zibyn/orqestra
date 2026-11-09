/** Splits a reply's parts into runs: consecutive steps (thinking, Tool calls) share one array, so they render in one Trace; any other part stands alone. */
export function groupSteps<T extends object>(
	parts: T[],
	isStep: (part: T) => boolean,
): (T | T[])[] {
	const out: (T | T[])[] = [];
	for (const part of parts) {
		const last = out.at(-1);
		if (!isStep(part)) out.push(part);
		else if (Array.isArray(last)) last.push(part);
		else out.push([part]);
	}
	return out;
}
