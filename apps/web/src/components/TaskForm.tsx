import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import {
	CheckCircle2Icon,
	CircleHelpIcon,
	Loader2Icon,
	PauseCircleIcon,
	SkipForwardIcon,
	XCircleIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { type AgentOption, levelLabels } from "#/components/Composer";
import { Item, ItemList, SheetForm } from "#/components/ConsolePage";
import { Picker } from "#/components/Picker";
import { UnreadMark } from "#/components/UnreadMark";
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
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import { ok } from "#/lib/api";
import {
	describeCron,
	fromWallClock,
	nextFirings,
	wallClock,
} from "#/lib/next-firing";
import {
	inUnits,
	type Outcome,
	type Schedule,
	type Task,
	type TaskDraft,
	taskError,
	tasksApi,
	UNITS,
	when,
} from "#/lib/tasks";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export const OUTCOMES: Record<
	Outcome,
	{ icon: ReactNode; label: () => string }
> = {
	running: {
		icon: <Loader2Icon className="size-4 animate-spin text-signal" />,
		label: m.firing_running,
	},
	completed: {
		icon: <CheckCircle2Icon className="size-4 text-foreground" />,
		label: m.firing_completed,
	},
	partial: {
		icon: <PauseCircleIcon className="size-4 text-muted-foreground" />,
		label: m.firing_partial,
	},
	question: {
		icon: <CircleHelpIcon className="size-4 text-muted-foreground" />,
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
	// times are entered on the clocks of the task's time zone
	const [timeZone, setTimeZone] = useState(task?.timeZone ?? browserZone);
	const s = d?.schedule;
	const [kind, setKind] = useState<Schedule["kind"]>(s?.kind ?? "cron");
	const [at, setAt] = useState(
		wallClock(
			s?.kind === "once" ? new Date(s.at) : new Date(Date.now() + 3600_000),
			timeZone,
		),
	);
	const every = inUnits(s?.kind === "every" ? s.seconds : 86400);
	const [n, setN] = useState(String(every.n));
	const [unit, setUnit] = useState(every.unit.value);
	const [expr, setExpr] = useState(s?.kind === "cron" ? s.expr : "0 9 * * 1-5");
	const [ends, setEnds] = useState(
		d?.endsAt ? wallClock(new Date(d.endsAt), timeZone).slice(0, 10) : "",
	);
	const [incognito, setIncognito] = useState(d?.incognito ?? false);
	const [alert, setAlert] = useState(task?.alertOnComplete ?? true);
	const [enabled, setEnabled] = useState(!task || task.state === "active");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const described = describeCron(expr, getLocale());
	const upcoming = nextFirings({ kind: "cron", expr }, timeZone, 3)
		.map((t) => when(t))
		.join(", ");
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
					? { kind, at: fromWallClock(at, timeZone).toISOString() }
					: kind === "every"
						? { kind, seconds: Number(n) * Number(unit) }
						: { kind, expr },
			// the end of that day, in the task's time zone
			endsAt:
				kind !== "once" && ends
					? new Date(
							fromWallClock(`${ends}T23:59`, timeZone).getTime() + 59_000,
						).toISOString()
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
					<ToggleGroup
						variant="outline"
						spacing={0}
						className="w-full"
						value={[kind]}
						// a pressed kind stays pressed: a schedule always has one
						onValueChange={([k]) => k && setKind(k as Schedule["kind"])}
					>
						{(["once", "every", "cron"] as const).map((k) => (
							<ToggleGroupItem key={k} value={k} className="flex-1">
								{{ once: m.task_once, every: m.task_every, cron: m.task_cron }[
									k
								]()}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
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
								{described && upcoming
									? `${described} · ${m.task_cron_next({ times: upcoming })}`
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
			{!!data?.firings.length && (
				<ItemList>
					{data.firings.map((f) => (
						<Item
							key={f.id}
							title={
								<>
									<span title={OUTCOMES[f.outcome].label()}>
										{OUTCOMES[f.outcome].icon}
										<span className="sr-only">
											{OUTCOMES[f.outcome].label()}
										</span>
									</span>
									{f.conversationId ? (
										<Link
											to="/c/$conversationId"
											params={{ conversationId: f.conversationId }}
											className="text-link underline"
										>
											{f.title ?? m.untitled_conversation()}
										</Link>
									) : (
										<span className="text-muted-foreground">
											{(f.reason && REASONS[f.reason]?.()) ||
												OUTCOMES[f.outcome].label()}
										</span>
									)}
									<UnreadMark unread={!!f.unread} awaitingReply={false} />
								</>
							}
							description={when(f.firedAt)}
						/>
					))}
				</ItemList>
			)}
		</section>
	);
}
