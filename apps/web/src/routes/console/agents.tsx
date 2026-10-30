import {
	type AgentDefinitionInput,
	mcpServerOf,
	mcpToolRef,
	slugify,
	thinkingLevel,
	toolName,
} from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { MessageResponse } from "#/components/ai-elements/message";
import { Picker } from "#/components/Picker";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { Textarea } from "#/components/ui/textarea";
import { deleteAgent, listAgents, saveAgent } from "#/lib/agents";
import { saveErrorTexts } from "#/lib/save-errors";
import { inlineCode } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/agents")({
	loader: () => listAgents(),
	component: Agents,
});

type Data = Awaited<ReturnType<typeof listAgents>>;
type Listed = Data["agents"][number];

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : m.request_failed();

function Agents() {
	const { agents, availableTools } = Route.useLoaderData();
	const [editing, setEditing] = useState<string | "new">();

	return (
		<section className="flex flex-col gap-6">
			<div className="flex items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{m.console_agents()}</h1>
				{editing !== "new" && (
					<Button onClick={() => setEditing("new")}>{m.new_agent()}</Button>
				)}
			</div>
			<p className="text-sm text-muted-foreground">{m.agents_hint()}</p>
			{editing === "new" && <AgentForm onDone={() => setEditing(undefined)} />}
			{agents.map((agent) =>
				editing === agent.id ? (
					<AgentForm
						key={agent.id}
						agent={agent}
						onDone={() => setEditing(undefined)}
					/>
				) : (
					<AgentCard
						key={agent.id}
						agent={agent}
						availableTools={availableTools}
						onEdit={() => setEditing(agent.id)}
					/>
				),
			)}
		</section>
	);
}

function AgentCard({
	agent,
	availableTools,
	onEdit,
}: {
	agent: Listed;
	availableTools: Data["availableTools"];
	onEdit: () => void;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const def = agent.definition;
	const missingTools = (def.tools ?? toolName.options).filter(
		(t) => !availableTools.includes(t),
	);

	return (
		<div className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
			<div className="flex items-start justify-between gap-2">
				<h2 className="font-medium">
					{def.name} <code className={inlineCode}>{agent.id}</code>
					{def.default && ` (${m.default_marker()})`}
					{!def.pickable && ` (${m.agent_template_only()})`}
				</h2>
				<div className="flex gap-2">
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m.edit()}
					</Button>
					{!def.default && (
						<Button
							size="sm"
							variant="destructive"
							disabled={busy}
							onClick={async () => {
								if (!confirm(m.delete_agent_confirm())) return;
								setBusy(true);
								try {
									await deleteAgent({ data: agent.id });
									await router.invalidate();
								} catch (e) {
									setError(errorText(e));
								} finally {
									setBusy(false);
								}
							}}
						>
							{busy && <Loader2Icon className="animate-spin" />}
							{m.delete()}
						</Button>
					)}
				</div>
			</div>
			<p className="text-muted-foreground">{def.description}</p>
			<p>
				{m.agent_models()}:{" "}
				{agent.models.map((model, i) => (
					<span key={model}>
						{i > 0 && ", "}
						<code className={inlineCode}>{model}</code>
						{model === agent.defaultModel && ` (${m.default_marker()})`}
					</span>
				))}
			</p>
			{agent.unavailableModels.map((model) => (
				<p key={model} className="text-destructive">
					{m.model_unavailable({ model })}
				</p>
			))}
			{agent.models.length === 0 && (
				<p className="text-destructive">{m.agent_no_models()}</p>
			)}
			{missingTools.map((tool) => {
				const server = mcpServerOf(tool);
				return (
					<p key={tool} className="text-destructive">
						{server
							? m.mcp_server_unavailable({ server })
							: m.tool_unavailable({ tool })}
					</p>
				);
			})}
			{error && <p className="text-destructive">{error}</p>}
		</div>
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
	const { enabledModels, mcpServers } = Route.useLoaderData();
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
	const toggle = <T,>(list: T[] | undefined, item: T, on: boolean) => {
		const next = on
			? [...(list ?? []), item]
			: (list ?? []).filter((x) => x !== item);
		return next.length ? next : undefined;
	};

	async function save() {
		setBusy(true);
		try {
			const result = await saveAgent({
				data: { id, create: !agent, definition: def },
			});
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
		<form
			className="flex flex-col gap-4 rounded-lg border p-4 text-sm"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
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
			<Field id={fieldId("id")} label={m.agent_id()} error={fieldError("id")}>
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
			<div className="flex flex-col gap-2">
				<div className="flex items-center justify-between">
					<Label htmlFor={fieldId("instructions")}>
						{m.agent_instructions()}
					</Label>
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
			</div>
			<Toggles
				label={m.agent_models()}
				hint={m.agent_models_hint()}
				error={fieldError("models")}
				items={modelChoices.map((x) => ({ value: x.ref, label: x.name }))}
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
				items={thinkingLevel.options.map((l) => ({ value: l, label: l }))}
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
			{errors[""] && <p className="text-destructive">{errors[""]}</p>}
			<div className="flex gap-2">
				<Button type="submit" disabled={busy}>
					{busy && <Loader2Icon className="animate-spin" />}
					{m.save()}
				</Button>
				<Button type="button" variant="outline" onClick={onDone}>
					{m.cancel()}
				</Button>
			</div>
		</form>
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
		<div className="flex flex-col gap-2">
			<Label htmlFor={id}>{label}</Label>
			{hint && <p className="text-muted-foreground">{hint}</p>}
			{children}
			{error && <p className="text-destructive">{error}</p>}
		</div>
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
		<fieldset className="flex flex-col gap-2">
			<legend className="mb-2 font-medium">{label}</legend>
			{hint && <p className="text-muted-foreground">{hint}</p>}
			<ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
				{items.map((item) => (
					<li key={item.value} className="flex items-center gap-3">
						<Switch
							id={`${idPrefix}-${item.value}`}
							checked={checked.includes(item.value)}
							onCheckedChange={(on) => onToggle(item.value, on)}
						/>
						<Label htmlFor={`${idPrefix}-${item.value}`}>{item.label}</Label>
					</li>
				))}
			</ul>
			{error && <p className="text-destructive">{error}</p>}
		</fieldset>
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
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-3">
				<Switch id={id} checked={checked} onCheckedChange={onChange} />
				<Label htmlFor={id}>{label}</Label>
			</div>
			{hint && <p className="text-muted-foreground">{hint}</p>}
			{error && <p className="text-destructive">{error}</p>}
		</div>
	);
}
