import { api, ok } from "#/lib/api";
import { describeCron } from "#/lib/next-firing";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export const tasksApi = () => api().api["scheduled-tasks"];
export const getTasks = () => ok(tasksApi().get());

export type Task = Awaited<ReturnType<typeof getTasks>>[number];
export type Schedule = Task["schedule"];
export type Outcome = NonNullable<Task["last"]>["outcome"];
export type State = Task["state"];
/** What a new task starts from: an Agent's Task Draft, with the Turn that drafted it. */
export type TaskDraft = Pick<
	Task,
	| "name"
	| "prompt"
	| "agentId"
	| "model"
	| "thinking"
	| "schedule"
	| "endsAt"
	| "incognito"
>;

export const when = (time: string | Date) =>
	new Date(time).toLocaleString(getLocale(), {
		dateStyle: "medium",
		timeStyle: "short",
	});

export const UNITS = [
	{ value: "86400", label: () => m.task_days() },
	{ value: "3600", label: () => m.task_hours() },
	{ value: "60", label: () => m.task_minutes() },
];
/** `seconds` in the largest unit that divides it. */
export const inUnits = (seconds: number) => {
	const unit = UNITS.find((u) => seconds % Number(u.value) === 0) ?? UNITS[2];
	return { n: seconds / Number(unit.value), unit };
};

export function summary(schedule: Schedule) {
	if (schedule.kind === "once")
		return m.task_summary_once({ time: when(schedule.at) });
	if (schedule.kind === "cron")
		return (
			describeCron(schedule.expr, getLocale()) ??
			m.task_summary_cron({ expr: schedule.expr })
		);
	const { n, unit } = inUnits(schedule.seconds);
	return m.task_summary_every({ n, unit: unit.label() });
}

const ERRORS: Record<string, () => string> = {
	agent_not_pickable: m.task_error_agent_not_pickable,
	model_unavailable: m.task_error_model_unavailable,
	thinking_unavailable: m.task_error_thinking_unavailable,
	invalid: m.task_error_invalid,
	in_past: m.task_error_in_past,
	too_frequent: m.task_error_too_frequent,
	too_many: m.task_error_too_many,
};
/** A refused save's first field error, in the User's language. */
export function taskError(e: unknown) {
	const errors = (
		e as { value?: { errors?: Record<string, { code: string }> } }
	)?.value?.errors;
	const code = errors && Object.values(errors)[0]?.code;
	return (code && ERRORS[code]?.()) || m.request_failed();
}
