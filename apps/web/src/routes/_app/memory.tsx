import {
	createFileRoute,
	getRouteApi,
	Link,
	useRouter,
} from "@tanstack/react-router";
import { BrainIcon } from "lucide-react";
import { useState } from "react";
import { pickModel } from "#/components/Composer";
import {
	ConsolePage,
	DeleteButton,
	FormSheet,
	Item,
	ItemList,
	SheetForm,
	useSheet,
} from "#/components/ConsolePage";
import { TaskForm } from "#/components/TaskForm";
import { Alert, AlertDescription } from "#/components/ui/alert";
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
import { errorText } from "#/lib/save-errors";
import type { TaskDraft } from "#/lib/tasks";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

const appRoute = getRouteApi("/_app");
const memoryApi = () => api().api.memories;
const getMemories = () => ok(memoryApi().get());

export const Route = createFileRoute("/_app/memory")({
	loader: getMemories,
	component: MemoryPage,
});

type Data = Awaited<ReturnType<typeof getMemories>>;
type Memory = Data["memories"][number];

/** The signed-in User's Memories: filter, view and edit, delete one or all, the memory master switch, and a Scheduled Task to tidy them. */
function MemoryPage() {
	const { memories, on, limits } = Route.useLoaderData();
	const { agents, models } = appRoute.useLoaderData();
	const tidiers = agents.filter((a) => a.pickable);
	const tidyModel = pickModel(models);
	const tidy = useSheet<TaskDraft>();
	const router = useRouter();
	const sheet = useSheet<Memory>();
	const [filter, setFilter] = useState("");
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");

	async function act(key: string, action: () => Promise<unknown>) {
		setBusy(key);
		try {
			await action();
			setError("");
			await router.invalidate();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(undefined);
		}
	}

	const words = filter.trim().toLowerCase();
	const shown = memories.filter((x) =>
		`${x.path}\n${x.description}\n${x.body}`.toLowerCase().includes(words),
	);

	return (
		<div className="flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-10">
			<ConsolePage
				title={m.memory_page()}
				description={m.memory_page_hint()}
				action={
					<>
						<div className="flex items-center gap-2">
							<Switch
								id="memory-on"
								checked={on}
								disabled={!!busy}
								onCheckedChange={(v) =>
									act("on", () => ok(memoryApi().on.put({ on: v })))
								}
							/>
							<Label htmlFor="memory-on">{m.memory_on()}</Label>
						</div>
						{!!tidiers.length && (
							<Button
								variant="outline"
								disabled={!!busy || !on}
								onClick={() =>
									tidy.show({
										name: m.memory_consolidate_name(),
										prompt: m.memory_consolidate_prompt(),
										agentId: tidiers[0].id,
										model: tidyModel.ref,
										thinking: tidyModel.thinking.default,
										schedule: { kind: "cron", expr: "0 4 * * *" },
										endsAt: null,
										incognito: false,
									})
								}
							>
								{m.memory_consolidate()}
							</Button>
						)}
						<Button
							variant="outline"
							disabled={!!busy || !memories.length}
							onClick={() => {
								if (confirm(m.memory_delete_all_confirm()))
									void act("all", () => ok(memoryApi().delete()));
							}}
						>
							{m.memory_delete_all()}
						</Button>
					</>
				}
			>
				{!on && (
					<Alert>
						<AlertDescription>{m.memory_off_notice()}</AlertDescription>
					</Alert>
				)}
				{!!memories.length && (
					<Input
						type="search"
						aria-label={m.memory_filter()}
						placeholder={m.memory_filter()}
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
				)}
				<ItemList
					empty={
						memories.length
							? { icon: BrainIcon, title: m.no_memories_match(), hint: "" }
							: {
									icon: BrainIcon,
									title: m.no_memories_title(),
									hint: m.no_memories(),
								}
					}
				>
					{shown.map((x) => (
						<Item
							key={x.path}
							title={<span className="font-mono text-sm">{x.path}</span>}
							description={x.description}
							actions={
								<>
									<Button
										size="sm"
										variant="outline"
										onClick={() => sheet.show(x)}
									>
										{m.edit()}
									</Button>
									<DeleteButton
										busy={busy === `delete-${x.path}`}
										disabled={!!busy}
										onClick={() => {
											if (confirm(m.memory_delete_confirm()))
												void act(`delete-${x.path}`, () =>
													ok(
														// Eden puts a path parameter in the URL as it is
														memoryApi()({
															path: encodeURIComponent(x.path),
														}).delete(),
													),
												);
										}}
									/>
								</>
							}
						>
							<p className="text-xs text-muted-foreground">
								<Source memory={x} /> ·{" "}
								{new Date(x.updatedAt).toLocaleString(getLocale())}
							</p>
						</Item>
					))}
				</ItemList>
				<FieldError>{error}</FieldError>
				<FormSheet
					open={sheet.open}
					onClose={sheet.close}
					title={<span className="font-mono">{sheet.item?.path}</span>}
					description={sheet.item && <Source memory={sheet.item} />}
				>
					{sheet.item && (
						<MemoryForm
							memory={sheet.item}
							limits={limits}
							onSaved={sheet.close}
						/>
					)}
				</FormSheet>
				<FormSheet open={tidy.open} onClose={tidy.close} title={m.task_new()}>
					{tidy.item && (
						<TaskForm draft={tidy.item} agents={tidiers} onSaved={tidy.close} />
					)}
				</FormSheet>
			</ConsolePage>
		</div>
	);
}

/** The Conversation that last wrote it, linked, or that it was deleted. */
function Source({ memory }: { memory: Memory }) {
	if (!memory.conversation) return m.memory_from_deleted();
	return (
		<Link
			to="/c/$conversationId"
			params={{ conversationId: memory.conversation.id }}
			className="text-link underline"
		>
			{m.memory_from({
				title: memory.conversation.title ?? m.untitled_conversation(),
			})}
		</Link>
	);
}

/** Edits a Memory's description and body; the server checks the same limits again. */
function MemoryForm({
	memory,
	limits,
	onSaved,
}: {
	memory: Memory;
	limits: Data["limits"];
	onSaved: () => void;
}) {
	const router = useRouter();
	const [description, setDescription] = useState(memory.description);
	const [body, setBody] = useState(memory.body);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const bytes = new TextEncoder().encode(body).length;

	async function save() {
		if (bytes > limits.body)
			return setError(m.memory_body_too_long({ max: limits.body, bytes }));
		setBusy(true);
		try {
			await ok(memoryApi().put({ path: memory.path, description, body }));
			await router.invalidate();
			onSaved();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<SheetForm onSubmit={() => void save()} busy={busy} submitLabel={m.save()}>
			<FieldGroup className="gap-5">
				<Field>
					<FieldLabel htmlFor="memory-description">
						{m.memory_description()}
					</FieldLabel>
					<Input
						id="memory-description"
						maxLength={limits.description}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="memory-body">{m.memory_body()}</FieldLabel>
					<Textarea
						id="memory-body"
						className="min-h-64 font-mono text-sm"
						value={body}
						onChange={(e) => setBody(e.target.value)}
					/>
				</Field>
				<FieldError>{error}</FieldError>
			</FieldGroup>
		</SheetForm>
	);
}
