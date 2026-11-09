import {
	type AgentDefinitionInput,
	mcpServerOf,
	mcpToolRef,
	slugify,
	thinkingLevel,
	toolName,
} from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PlusIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MessageResponse } from "#/components/ai-elements/message";
import {
	ConsolePage,
	DeleteButton,
	FormSheet,
	Item,
	ItemList,
	SheetForm,
	useSheet,
} from "#/components/ConsolePage";
import { Picker } from "#/components/Picker";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	FieldContent,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSeparator,
	FieldSet,
	Field as UiField,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#/lib/api";
import { errorText, ok, saved, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

const listAgents = () => ok(api().api.agents.get());

export const Route = createFileRoute("/console/agents")({
	loader: listAgents,
	component: Agents,
});

type Data = Awaited<ReturnType<typeof listAgents>>;
type Listed = Data["agents"][number];

function Agents() {
	const { agents, availableTools, availableSkills } = Route.useLoaderData();
	const sheet = useSheet<Listed | undefined>();

	return (
		<ConsolePage
			title={m.console_agents()}
			description={m.agents_hint()}
			action={
				<Button onClick={() => sheet.show(undefined)}>
					<PlusIcon data-icon="inline-start" />
					{m.new_agent()}
				</Button>
			}
		>
			<ItemList>
				{agents.map((agent) => (
					<AgentItem
						key={agent.id}
						agent={agent}
						availableTools={availableTools}
						availableSkills={availableSkills}
						onEdit={() => sheet.show(agent)}
					/>
				))}
			</ItemList>
			<FormSheet
				open={sheet.open}
				onClose={sheet.close}
				className="data-[side=right]:sm:max-w-2xl"
				title={sheet.item?.definition.name ?? m.new_agent()}
			>
				<AgentForm agent={sheet.item} onDone={sheet.close} />
			</FormSheet>
		</ConsolePage>
	);
}

function AgentItem({
	agent,
	availableTools,
	availableSkills,
	onEdit,
}: {
	agent: Listed;
	availableTools: Data["availableTools"];
	availableSkills: Data["availableSkills"];
	onEdit: () => void;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const def = agent.definition;
	// no `tools` means every available one, so only named Tools can be missing
	const missingTools = (def.tools ?? []).filter(
		(t) => !availableTools.includes(t),
	);

	const issues = [
		...agent.unavailableModels.map((model) => m.model_unavailable({ model })),
		...(agent.models.length === 0 ? [m.agent_no_models()] : []),
		...missingTools.map((tool) => {
			const server = mcpServerOf(tool);
			return server
				? m.mcp_server_unavailable({ server })
				: m.tool_unavailable({ tool });
		}),
		...(def.skills ?? [])
			.filter((skill) => !availableSkills.includes(skill))
			.map((skill) => m.skill_unavailable({ skill })),
	];

	return (
		<Item
			title={
				<>
					{def.name}
					<Badge variant="outline" className="font-mono">
						{agent.id}
					</Badge>
					{def.default && <Badge>{m.default_marker()}</Badge>}
					{!def.pickable && (
						<Badge variant="secondary">{m.agent_template_only()}</Badge>
					)}
				</>
			}
			description={def.description}
			actions={
				<>
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m.edit()}
					</Button>
					{!def.default && (
						<DeleteButton
							busy={busy}
							onClick={async () => {
								if (!confirm(m.delete_agent_confirm())) return;
								setBusy(true);
								try {
									await ok(api().api.agents({ id: agent.id }).delete());
									await router.invalidate();
								} catch (e) {
									setError(errorText(e));
								} finally {
									setBusy(false);
								}
							}}
						/>
					)}
				</>
			}
		>
			<div className="flex flex-wrap items-center gap-1.5 text-sm">
				<span className="mr-1 text-muted-foreground">{m.agent_models()}</span>
				{agent.models.map((model) => (
					<Badge
						key={model}
						variant={model === agent.defaultModel ? "default" : "secondary"}
						className="font-mono"
					>
						{model}
						{model === agent.defaultModel && ` · ${m.default_marker()}`}
					</Badge>
				))}
			</div>
			{issues.length > 0 && (
				<Alert variant="destructive">
					<TriangleAlertIcon />
					<AlertDescription>
						<ul className="flex flex-col gap-1">
							{issues.map((issue) => (
								<li key={issue}>{issue}</li>
							))}
						</ul>
					</AlertDescription>
				</Alert>
			)}
			<FieldError>{error}</FieldError>
		</Item>
	);
}

type AgentThinking = NonNullable<
	NonNullable<AgentDefinitionInput["thinking"]>["default"]
>;

const AUTO = "auto";

const empty: AgentDefinitionInput = {
	name: "",
	description: "",
	instructions: "",
	pickable: true,
	default: false,
};

/** Creates an Agent, or edits `agent`; its id is fixed once created. */
function AgentForm({ agent, onDone }: { agent?: Listed; onDone: () => void }) {
	const router = useRouter();
	const { enabledModels, mcpServers, skills, availableSkills } =
		Route.useLoaderData();
	const [def, setDef] = useState<AgentDefinitionInput>(
		agent?.definition ?? empty,
	);
	const [id, setId] = useState(agent?.id ?? "");
	// the id follows the name until edited by hand
	const [idEdited, setIdEdited] = useState(false);
	const [preview, setPreview] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const update = (patch: Partial<AgentDefinitionInput>) =>
		setDef((d) => ({ ...d, ...patch }));
	const fieldId = (name: string) => `${agent?.id ?? "new"}-${name}`;
	const fieldError = (field: string) =>
		Object.entries(errors).find(
			([key]) => key === field || key.startsWith(`${field}.`),
		)?.[1];

	// Models still named by the definition stay listed even when no longer enabled, so saving keeps them
	const modelChoices = [
		...enabledModels,
		...(def.models ?? [])
			.filter((ref) => !enabledModels.some((e) => e.ref === ref))
			.map((ref) => ({ ref, name: ref })),
	];
	// likewise a Skill deleted meanwhile, so the Admin can see and drop it
	const skillChoices = [
		...skills,
		...(def.skills ?? []).filter((name) => !skills.includes(name)),
	];
	const toggle = <T,>(list: T[] | undefined, item: T, on: boolean) => {
		const next = on
			? [...(list ?? []), item]
			: (list ?? []).filter((x) => x !== item);
		return next.length ? next : undefined;
	};

	async function save() {
		setBusy(true);
		try {
			const result = await saved(
				api().api.agents.post({ id, create: !agent, definition: def }),
			);
			setErrors(saveErrorTexts(result.errors));
			if (!Object.keys(result.errors).length) {
				await router.invalidate();
				onDone();
			}
		} catch (e) {
			setErrors({ "": errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<SheetForm onSubmit={() => void save()} busy={busy} submitLabel={m.save()}>
			<FieldGroup className="gap-6">
				<div className="grid gap-6 @md:grid-cols-2">
					<Field
						id={fieldId("name")}
						label={m.agent_name()}
						error={fieldError("name")}
					>
						<Input
							id={fieldId("name")}
							required
							value={def.name}
							onChange={(e) => {
								update({ name: e.target.value });
								if (!agent && !idEdited) setId(slugify(e.target.value));
							}}
						/>
					</Field>
					<Field
						id={fieldId("id")}
						label={m.agent_id()}
						error={fieldError("id")}
					>
						<Input
							id={fieldId("id")}
							required
							disabled={!!agent}
							pattern="[a-z0-9][a-z0-9\-]*"
							value={id}
							onChange={(e) => {
								setId(e.target.value);
								setIdEdited(true);
							}}
						/>
					</Field>
				</div>
				<Field
					id={fieldId("description")}
					label={m.agent_description()}
					hint={m.agent_description_hint()}
					error={fieldError("description")}
				>
					<Textarea
						id={fieldId("description")}
						required
						value={def.description}
						onChange={(e) => update({ description: e.target.value })}
					/>
				</Field>
				<UiField>
					<div className="flex items-center justify-between">
						<FieldLabel htmlFor={fieldId("instructions")}>
							{m.agent_instructions()}
						</FieldLabel>
						<div className="flex gap-1">
							<Button
								type="button"
								size="sm"
								variant={preview ? "ghost" : "secondary"}
								aria-pressed={!preview}
								onClick={() => setPreview(false)}
							>
								{m.edit()}
							</Button>
							<Button
								type="button"
								size="sm"
								variant={preview ? "secondary" : "ghost"}
								aria-pressed={preview}
								onClick={() => setPreview(true)}
							>
								{m.preview()}
							</Button>
						</div>
					</div>
					{preview ? (
						<div className="min-h-16 rounded-md border px-2.5 py-2">
							<MessageResponse>{def.instructions}</MessageResponse>
						</div>
					) : (
						<Textarea
							id={fieldId("instructions")}
							className="min-h-48 font-mono"
							value={def.instructions}
							onChange={(e) => update({ instructions: e.target.value })}
						/>
					)}
				</UiField>
				<FieldSeparator />
				<Toggles
					label={m.agent_models()}
					hint={m.agent_models_hint()}
					error={fieldError("models")}
					items={modelChoices.map((x) => ({
						value: x.ref,
						label: x.name,
					}))}
					checked={def.models ?? []}
					onToggle={(ref, on) => {
						const models = toggle(def.models, ref, on);
						update({
							models,
							defaultModel:
								models && def.defaultModel && !models.includes(def.defaultModel)
									? undefined
									: def.defaultModel,
						});
					}}
					idPrefix={fieldId("model")}
				/>
				<Picker
					label={m.agent_default_model()}
					error={fieldError("defaultModel")}
					value={def.defaultModel ?? AUTO}
					onChange={(v) => update({ defaultModel: v === AUTO ? undefined : v })}
					items={[
						{ value: AUTO, label: m.automatic() },
						...modelChoices
							.filter((x) => !def.models || def.models.includes(x.ref))
							.map((x) => ({ value: x.ref, label: x.name })),
					]}
				/>
				<Toggles
					label={m.agent_thinking_allowed()}
					hint={m.agent_thinking_allowed_hint()}
					error={fieldError("thinking.allowed")}
					items={thinkingLevel.options.map((l) => ({
						value: l,
						label: l,
					}))}
					checked={def.thinking?.allowed ?? []}
					onToggle={(level, on) =>
						update({
							thinking: {
								...def.thinking,
								allowed: toggle(def.thinking?.allowed, level, on),
							},
						})
					}
					idPrefix={fieldId("thinking")}
				/>
				<Picker
					label={m.agent_thinking_default()}
					error={fieldError("thinking.default")}
					value={def.thinking?.default ?? AUTO}
					onChange={(v) =>
						update({
							thinking: {
								...def.thinking,
								default: v === AUTO ? undefined : (v as AgentThinking),
							},
						})
					}
					items={[
						{ value: AUTO, label: m.automatic() },
						...(def.thinking?.allowed ?? thinkingLevel.options).map((l) => ({
							value: l,
							label: l,
						})),
					]}
				/>
				<FieldSeparator />
				<Toggles
					label={m.agent_tools()}
					error={fieldError("tools")}
					items={[
						...toolName.options.map((t) => ({ value: t, label: t })),
						...mcpServers.map((s) => ({
							value: mcpToolRef(s.id),
							label: m.mcp_server_tool({ name: s.name }),
						})),
					]}
					checked={def.tools ?? toolName.options}
					onToggle={(tool, on) => {
						const tools = on
							? [...(def.tools ?? toolName.options), tool]
							: (def.tools ?? toolName.options).filter((t) => t !== tool);
						// Search and Scrape without MCP Servers is what omitting `tools` means
						update({
							tools:
								toolName.options.every((t) => tools.includes(t)) &&
								!tools.some(mcpServerOf)
									? undefined
									: tools,
						});
					}}
					idPrefix={fieldId("tool")}
				/>
				<Toggles
					label={m.agent_skills()}
					hint={m.agent_skills_hint()}
					error={fieldError("skills")}
					items={skillChoices.map((name) => ({
						value: name,
						label: availableSkills.includes(name)
							? name
							: m.skill_unavailable_label({ name }),
					}))}
					checked={def.skills ?? []}
					onToggle={(name, on) =>
						update({ skills: toggle(def.skills, name, on) })
					}
					idPrefix={fieldId("skill")}
				/>
				<FieldSeparator />
				<SwitchField
					id={fieldId("memory")}
					label={m.agent_memory()}
					hint={m.agent_memory_hint()}
					error={fieldError("memory")}
					checked={def.memory ?? false}
					onChange={(memory) => update({ memory })}
				/>
				<SwitchField
					id={fieldId("pickable")}
					label={m.agent_pickable()}
					hint={m.agent_pickable_hint()}
					error={fieldError("pickable")}
					checked={def.pickable ?? true}
					onChange={(pickable) => update({ pickable })}
				/>
				<SwitchField
					id={fieldId("default")}
					label={m.agent_default()}
					error={fieldError("default")}
					checked={def.default ?? false}
					onChange={(on) => update({ default: on })}
				/>
				<FieldError>{errors[""]}</FieldError>
			</FieldGroup>
		</SheetForm>
	);
}

function Field({
	id,
	label,
	hint,
	error,
	children,
}: {
	id: string;
	label: string;
	hint?: string;
	error?: string;
	children: ReactNode;
}) {
	return (
		<UiField data-invalid={!!error || undefined}>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			{children}
			{hint && <FieldDescription>{hint}</FieldDescription>}
			<FieldError>{error}</FieldError>
		</UiField>
	);
}

function Toggles<T extends string>({
	label,
	hint,
	error,
	items,
	checked,
	onToggle,
	idPrefix,
}: {
	label: string;
	hint?: string;
	error?: string;
	items: { value: T; label: string }[];
	checked: readonly T[];
	onToggle: (value: T, on: boolean) => void;
	idPrefix: string;
}) {
	return (
		<FieldSet className="gap-3">
			<FieldLegend variant="label" className="mb-0">
				{label}
			</FieldLegend>
			{hint && <FieldDescription>{hint}</FieldDescription>}
			{items.length > 0 && (
				<div className="grid max-h-72 gap-3 overflow-y-auto rounded-lg border p-3 @md:grid-cols-2 @xl:grid-cols-3">
					{items.map((item) => (
						<UiField key={item.value} orientation="horizontal">
							<Switch
								id={`${idPrefix}-${item.value}`}
								checked={checked.includes(item.value)}
								onCheckedChange={(on) => onToggle(item.value, on)}
							/>
							<FieldLabel
								htmlFor={`${idPrefix}-${item.value}`}
								className="font-normal"
							>
								{item.label}
							</FieldLabel>
						</UiField>
					))}
				</div>
			)}
			<FieldError>{error}</FieldError>
		</FieldSet>
	);
}

function SwitchField({
	id,
	label,
	hint,
	error,
	checked,
	onChange,
}: {
	id: string;
	label: string;
	hint?: string;
	error?: string;
	checked: boolean;
	onChange: (on: boolean) => void;
}) {
	return (
		<UiField orientation="horizontal" data-invalid={!!error || undefined}>
			<FieldContent>
				<FieldLabel htmlFor={id}>{label}</FieldLabel>
				{hint && <FieldDescription>{hint}</FieldDescription>}
				<FieldError>{error}</FieldError>
			</FieldContent>
			<Switch id={id} checked={checked} onCheckedChange={onChange} />
		</UiField>
	);
}
