import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { CronExpressionParser } from "cron-parser";
import {
	CheckCircle2Icon,
	CircleHelpIcon,
	Loader2Icon,
	PauseCircleIcon,
	SkipForwardIcon,
	XCircleIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { type AgentOption, levelLabels } from "#/components/Composer";
import { SheetForm } from "#/components/ConsolePage";
import { Picker } from "#/components/Picker";
import { Button } from "#/components/ui/button";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { Textarea } from "#/components/ui/textarea";
import { api, ok } from "#/lib/api";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export const tasksApi = () => api().api["scheduled-tasks"];
export const getTasks = () => ok(tasksApi().get());

export type Task = Awaited<ReturnType<typeof getTasks>>[number];
export type Schedule = Task["schedule"];
type Outcome = NonNullable<Task["last"]>["outcome"];
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

const UNITS = [
	{ value: "86400", label: () => m.task_days() },
	{ value: "3600", label: () => m.task_hours() },
	{ value: "60", label: () => m.task_minutes() },
];
/** `seconds` in the largest unit that divides it. */
const inUnits = (seconds: number) => {
	const unit = UNITS.find((u) => seconds % Number(u.value) === 0) ?? UNITS[2];
	return { n: seconds / Number(unit.value), unit };
};

export function summary(schedule: Schedule) {
	if (schedule.kind === "once")
		return m.task_summary_once({ time: when(schedule.at) });
	if (schedule.kind === "cron")
		return m.task_summary_cron({ expr: schedule.expr });
	const { n, unit } = inUnits(schedule.seconds);
	return m.task_summary_every({ n, unit: unit.label() });
}

export const OUTCOMES: Record<
	Outcome,
	{ icon: ReactNode; label: () => string }
> = {
	running: {
		icon: <Loader2Icon className="size-4 animate-spin text-signal" />,
		label: m.firing_running,
	},
	completed: {
		icon: <CheckCircle2Icon className="size-4 text-emerald-600" />,
		label: m.firing_completed,
	},
	partial: {
		icon: <PauseCircleIcon className="size-4 text-amber-600" />,
		label: m.firing_partial,
	},
	question: {
		icon: <CircleHelpIcon className="size-4 text-sky-600" />,
		label: m.firing_question,
	},
	skipped: {
		icon: <SkipForwardIcon className="size-4 text-muted-foreground" />,
		label: m.firing_skipped,
	},
	failed: {
		icon: <XCircleIcon className="size-4 text-destructive" />,
		label: m.firing_failed,
	},
};

const REASONS: Record<string, () => string> = {
	previous_running: m.firing_previous_running,
	agent_unavailable: m.firing_agent_unavailable,
	model_disabled: m.firing_model_disabled,
};

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

/** `YYYY-MM-DDTHH:mm` of a time, in the browser's time zone, for a datetime-local input. */
const localInput = (time: Date) =>
	new Date(time.getTime() - time.getTimezoneOffset() * 60_000)
		.toISOString()
		.slice(0, 16);

/** Creates (from a draft, if given) or edits a task, its Firings listed below; the server checks it again. */
export function TaskForm({
	task,
	draft,
	agents,
	onSaved,
}: {
	task?: Task;
	draft?: TaskDraft;
	agents: AgentOption[];
	onSaved: () => void;
}) {
	const router = useRouter();
	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const d = task ?? draft;
	const [name, setName] = useState(d?.name ?? "");
	const [prompt, setPrompt] = useState(d?.prompt ?? "");
	const [agentId, setAgentId] = useState(d?.agentId ?? agents[0]?.id ?? "");
	const agent = agents.find((a) => a.id === agentId) ?? agents[0];
	const [modelRef, setModel] = useState(d?.model ?? agent?.defaultModel);
	const model =
		agent?.models.find((x) => x.ref === modelRef) ??
		agent?.models.find((x) => x.ref === agent.defaultModel) ??
		agent?.models[0];
	const [picked, setThinking] = useState(d?.thinking);
	const thinking =
		picked && model?.thinking.allowed.includes(picked)
			? picked
			: model?.thinking.default;
	const s = d?.schedule;
	const [kind, setKind] = useState<Schedule["kind"]>(s?.kind ?? "cron");
	const [at, setAt] = useState(
		localInput(
			s?.kind === "once" ? new Date(s.at) : new Date(Date.now() + 3600_000),
		),
	);
	const every = inUnits(s?.kind === "every" ? s.seconds : 86400);
	const [n, setN] = useState(String(every.n));
	const [unit, setUnit] = useState(every.unit.value);
	const [expr, setExpr] = useState(s?.kind === "cron" ? s.expr : "0 9 * * 1-5");
	const [ends, setEnds] = useState(
		d?.endsAt ? localInput(new Date(d.endsAt)).slice(0, 10) : "",
	);
	const [timeZone, setTimeZone] = useState(task?.timeZone ?? browserZone);
	const [incognito, setIncognito] = useState(d?.incognito ?? false);
	const [alert, setAlert] = useState(task?.alertOnComplete ?? true);
	const [enabled, setEnabled] = useState(!task || task.state === "active");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	let upcoming: string | undefined;
	try {
		upcoming = CronExpressionParser.parse(expr, { tz: timeZone })
			.take(3)
			.map((d) => when(d.toDate()))
			.join(", ");
	} catch {}
	const zones = [
		...new Set([
			timeZone,
			browserZone,
			"UTC",
			...Intl.supportedValuesOf("timeZone"),
		]),
	];

	async function save() {
		if (!agent || !model || !thinking) return;
		const body = {
			name,
			prompt,
			agentId: agent.id,
			model: model.ref,
			thinking,
			schedule:
				kind === "once"
					? { kind, at: new Date(at).toISOString() }
					: kind === "every"
						? { kind, seconds: Number(n) * Number(unit) }
						: { kind, expr },
			// the end of that day, in the browser's time zone
			endsAt:
				kind !== "once" && ends
					? new Date(`${ends}T23:59:59`).toISOString()
					: null,
			timeZone,
			incognito,
			alertOnComplete: alert,
			enabled,
		};
		setBusy(true);
		try {
			await ok(
				task ? tasksApi()({ id: task.id }).put(body) : tasksApi().post(body),
			);
			await router.invalidate();
			onSaved();
		} catch (e) {
			setError(taskError(e));
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		if (!task || !confirm(m.task_delete_confirm())) return;
		setBusy(true);
		try {
			await ok(tasksApi()({ id: task.id }).delete());
			await router.invalidate();
			onSaved();
		} catch (e) {
			setError(taskError(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<SheetForm
			onSubmit={() => void save()}
			busy={busy}
			submitLabel={m.save()}
			extra={
				task && (
					<Button
						type="button"
						variant="destructive"
						disabled={busy}
						onClick={() => void remove()}
					>
						{m.delete()}
					</Button>
				)
			}
		>
			<FieldGroup className="gap-5">
				<Field>
					<FieldLabel htmlFor="task-name">{m.task_name()}</FieldLabel>
					<Input
						id="task-name"
						required
						maxLength={100}
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="task-prompt">{m.task_prompt()}</FieldLabel>
					<Textarea
						id="task-prompt"
						required
						className="min-h-28"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
					/>
				</Field>
				<div className="flex flex-wrap gap-4">
					{agent && (
						<Picker
							label={m.agent()}
							value={agent.id}
							onChange={setAgentId}
							items={agents.map((a) => ({ value: a.id, label: a.name }))}
						/>
					)}
					{agent && model && (
						<Picker
							label={m.task_model()}
							value={model.ref}
							onChange={setModel}
							items={agent.models.map((x) => ({
								value: x.ref,
								label: x.name,
							}))}
						/>
					)}
					{model && thinking && model.thinking.allowed.length > 1 && (
						<Picker
							label={m.task_thinking()}
							value={thinking}
							onChange={(v) => setThinking(v as typeof thinking)}
							items={model.thinking.allowed.map((l) => ({
								value: l,
								label: levelLabels[l](),
							}))}
						/>
					)}
				</div>
				<Field>
					<FieldLabel>{m.task_schedule()}</FieldLabel>
					<div className="flex gap-1 rounded-lg border p-1">
						{(["once", "every", "cron"] as const).map((k) => (
							<Button
								key={k}
								type="button"
								size="sm"
								variant={kind === k ? "secondary" : "ghost"}
								className="flex-1"
								aria-pressed={kind === k}
								onClick={() => setKind(k)}
							>
								{{ once: m.task_once, every: m.task_every, cron: m.task_cron }[
									k
								]()}
							</Button>
						))}
					</div>
					{kind === "once" && (
						<Input
							type="datetime-local"
							aria-label={m.task_once()}
							required
							value={at}
							onChange={(e) => setAt(e.target.value)}
						/>
					)}
					{kind === "every" && (
						<div className="flex items-end gap-2">
							<Input
								type="number"
								aria-label={m.task_every()}
								min={1}
								required
								className="w-24"
								value={n}
								onChange={(e) => setN(e.target.value)}
							/>
							<Picker
								label={m.task_unit()}
								value={unit}
								onChange={setUnit}
								items={UNITS.map((u) => ({ value: u.value, label: u.label() }))}
							/>
						</div>
					)}
					{kind === "cron" && (
						<>
							<Input
								aria-label={m.task_cron()}
								className="font-mono"
								required
								value={expr}
								onChange={(e) => setExpr(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								{upcoming
									? m.task_cron_next({ times: upcoming })
									: m.task_error_invalid()}
							</p>
						</>
					)}
					{kind !== "once" && (
						<div className="flex items-center gap-2 text-sm">
							<Label htmlFor="task-ends">{m.task_ends()}</Label>
							<Input
								id="task-ends"
								type="date"
								className="w-44"
								value={ends}
								onChange={(e) => setEnds(e.target.value)}
							/>
						</div>
					)}
				</Field>
				<Picker
					label={m.task_time_zone()}
					value={timeZone}
					onChange={setTimeZone}
					items={zones.map((z) => ({ value: z, label: z }))}
				/>
				<div className="flex flex-col gap-3">
					<Toggle
						id="task-incognito"
						label={m.task_incognito()}
						on={incognito}
						set={setIncognito}
					/>
					<Toggle
						id="task-alert"
						label={m.task_alert()}
						on={alert}
						set={setAlert}
					/>
					<Toggle
						id="task-enabled"
						label={m.task_enabled()}
						on={enabled}
						set={setEnabled}
					/>
				</div>
				<FieldError>{error}</FieldError>
			</FieldGroup>
			{task && <History id={task.id} />}
		</SheetForm>
	);
}

function Toggle({
	id,
	label,
	on,
	set,
}: {
	id: string;
	label: string;
	on: boolean;
	set: (on: boolean) => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<Switch id={id} checked={on} onCheckedChange={set} />
			<Label htmlFor={id}>{label}</Label>
		</div>
	);
}

/** A task's Firings, newest first: when, how it went, and its Conversation or why there is none. */
function History({ id }: { id: string }) {
	const { data } = useQuery({
		queryKey: ["task", id],
		queryFn: () => ok(tasksApi()({ id }).get()),
	});
	return (
		<section className="mt-8 flex flex-col gap-3 border-t pt-4">
			<h2 className="font-medium">{m.task_history()}</h2>
			{data && !data.firings.length && (
				<p className="text-sm text-muted-foreground">{m.task_no_firings()}</p>
			)}
			<ul className="flex flex-col gap-2">
				{data?.firings.map((f) => (
					<li key={f.id} className="flex items-start gap-2 text-sm">
						<span
							className="flex items-center gap-2"
							title={OUTCOMES[f.outcome].label()}
						>
							{OUTCOMES[f.outcome].icon}
							<span className="sr-only">{OUTCOMES[f.outcome].label()}</span>
						</span>
						<span className="w-36 shrink-0 text-muted-foreground">
							{when(f.firedAt)}
						</span>
						{f.conversationId ? (
							<Link
								to="/c/$conversationId"
								params={{ conversationId: f.conversationId }}
								className={
									f.unread
										? "font-semibold text-link underline"
										: "text-link underline"
								}
							>
								{f.title ?? m.untitled_conversation()}
							</Link>
						) : (
							<span className="text-muted-foreground">
								{(f.reason && REASONS[f.reason]?.()) ||
									OUTCOMES[f.outcome].label()}
							</span>
						)}
					</li>
				))}
			</ul>
		</section>
	);
}
