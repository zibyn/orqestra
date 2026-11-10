import {
	createFileRoute,
	getRouteApi,
	useRouter,
} from "@tanstack/react-router";
import { CalendarClockIcon, EyeOffIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	ConsolePage,
	FormSheet,
	Item,
	ItemList,
	useSheet,
} from "#/components/ConsolePage";
import { FiringAlertPrototype } from "#/components/TaskConnection.prototype";
import { OUTCOMES, TaskForm } from "#/components/TaskForm";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { FieldError } from "#/components/ui/field";
import { Switch } from "#/components/ui/switch";
import { ok } from "#/lib/api";
import {
	getTasks,
	type State,
	summary,
	type Task,
	taskError,
	tasksApi,
	when,
} from "#/lib/tasks";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/_app/tasks")({
	// an Alert about a task opens its drawer
	validateSearch: (search): { task?: string } =>
		typeof search.task === "string" ? { task: search.task } : {},
	loader: getTasks,
	component: TasksPage,
});

const appRoute = getRouteApi("/_app");

const STATES: Record<State, () => ReactNode> = {
	active: () => <Badge variant="secondary">{m.task_state_active()}</Badge>,
	paused: () => <Badge variant="outline">{m.task_state_paused()}</Badge>,
	auto_paused: () => (
		<Badge variant="destructive">{m.task_state_auto_paused()}</Badge>
	),
	finished: () => <Badge variant="outline">{m.task_state_finished()}</Badge>,
};

/** The signed-in User's Scheduled Tasks: each with its state, schedule, next and last Firing, switch, and a drawer to edit it. */
function TasksPage() {
	const tasks = Route.useLoaderData();
	const { agents } = appRoute.useLoaderData();
	const router = useRouter();
	const { task: opened } = Route.useSearch();
	const sheet = useSheet<Task | undefined>(tasks.find((t) => t.id === opened));
	const [error, setError] = useState("");

	async function enable(task: Task, enabled: boolean) {
		try {
			await ok(tasksApi()({ id: task.id }).enabled.put({ enabled }));
			setError("");
			await router.invalidate();
		} catch (e) {
			setError(taskError(e));
		}
	}

	return (
		<div className="flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-10">
			<ConsolePage
				title={m.tasks_page()}
				description={m.tasks_page_hint()}
				action={
					<Button onClick={() => sheet.show(undefined)}>
						<PlusIcon />
						{m.task_new()}
					</Button>
				}
			>
				{/* PROTOTYPE #81 */}
				<FiringAlertPrototype />
				<ItemList
					empty={{
						icon: CalendarClockIcon,
						title: m.task_none_title(),
						hint: m.task_none(),
					}}
				>
					{tasks.map((t) => (
						<Item
							key={t.id}
							title={
								<>
									{t.name}
									{STATES[t.state]()}
									{t.incognito && (
										<EyeOffIcon
											role="img"
											aria-label={m.incognito()}
											className="size-4 text-muted-foreground"
										/>
									)}
								</>
							}
							description={`${summary(t.schedule)}${t.next ? ` · ${m.task_next({ time: when(t.next) })}` : ""}`}
							actions={
								<>
									<Switch
										aria-label={m.task_enabled()}
										checked={t.state === "active"}
										onCheckedChange={(v) => void enable(t, v)}
									/>
									<Button
										size="sm"
										variant="outline"
										onClick={() => sheet.show(t)}
									>
										{m.task_open()}
									</Button>
								</>
							}
						>
							{t.last && (
								<p className="flex items-center gap-2 text-xs">
									{OUTCOMES[t.last.outcome].icon}
									{m.task_last({
										time: when(t.last.firedAt),
										outcome: OUTCOMES[t.last.outcome].label(),
									})}
								</p>
							)}
						</Item>
					))}
				</ItemList>
				<FieldError>{error}</FieldError>
				<FormSheet
					open={sheet.open}
					onClose={sheet.close}
					title={sheet.item?.name ?? m.task_new()}
					description={sheet.item && summary(sheet.item.schedule)}
				>
					<TaskForm
						task={sheet.item}
						agents={agents.filter((a) => a.pickable)}
						onSaved={sheet.close}
					/>
				</FormSheet>
			</ConsolePage>
		</div>
	);
}
