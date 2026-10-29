import { useState } from "react";
import {
	PromptInput,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
} from "#/components/ai-elements/prompt-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { getAgentOptions } from "#/lib/conversation-fns";
import { m } from "#/paraglide/messages";

export type AgentOption = Awaited<ReturnType<typeof getAgentOptions>>[number];
type Level = AgentOption["models"][number]["thinking"]["default"];
export type Choice = { model?: string; thinking?: Level };

const levelLabels: Record<Level, () => string> = {
	off: m.thinking_off,
	minimal: m.thinking_minimal,
	low: m.thinking_low,
	medium: m.thinking_medium,
	high: m.thinking_high,
	xhigh: m.thinking_xhigh,
	max: m.thinking_max,
};

/** Message input with the Agent (new Conversations only), Model and thinking pickers; a picker with one option is hidden. */
export function Composer({
	agents,
	agentId,
	onAgentChange,
	initial,
	running,
	onSend,
	onStop,
}: {
	agents: AgentOption[];
	agentId: string;
	onAgentChange?: (id: string) => void;
	/** Last message's pick; one the Agent no longer allows falls back to its default. */
	initial?: Choice;
	running: boolean;
	onSend: (message: Required<Choice> & { text: string }) => Promise<unknown>;
	onStop: () => void;
}) {
	const [text, setText] = useState("");
	const [picked, setPicked] = useState<Choice>(initial ?? {});
	const [error, setError] = useState("");
	const [sending, setSending] = useState(false);
	const agent = agents.find((a) => a.id === agentId) ?? agents[0];
	const model =
		agent.models.find((x) => x.ref === picked.model) ??
		agent.models.find((x) => x.ref === agent.defaultModel) ??
		agent.models[0];
	const thinking =
		picked.thinking && model.thinking.allowed.includes(picked.thinking)
			? picked.thinking
			: model.thinking.default;

	return (
		<div className="mx-auto w-full max-w-3xl px-4 pb-4">
			<PromptInput
				onSubmit={async (e) => {
					e.preventDefault();
					// sent while running, it waits in the inbox for the next step boundary
					if (!text.trim() || sending) return;
					setSending(true);
					setError("");
					try {
						await onSend({ text, model: model.ref, thinking });
						setText("");
					} catch {
						setError(m.request_failed());
					} finally {
						setSending(false);
					}
				}}
			>
				<PromptInputTextarea
					aria-label={m.composer_placeholder()}
					placeholder={m.composer_placeholder()}
					value={text}
					onChange={(e) => setText(e.target.value)}
				/>
				<PromptInputFooter>
					{onAgentChange && agents.length > 1 && (
						<Picker
							label={m.agent()}
							value={agent.id}
							onChange={onAgentChange}
							items={agents.map((a) => ({ value: a.id, label: a.name }))}
						/>
					)}
					{agent.models.length > 1 && (
						<Picker
							label={m.agent_models()}
							value={model.ref}
							onChange={(ref) => setPicked({ ...picked, model: ref })}
							items={agent.models.map((x) => ({ value: x.ref, label: x.name }))}
						/>
					)}
					{model.thinking.allowed.length > 1 && (
						<Picker
							label={m.thinking_level()}
							value={thinking}
							onChange={(level) =>
								setPicked({ ...picked, thinking: level as Level })
							}
							items={model.thinking.allowed.map((l) => ({
								value: l,
								label: levelLabels[l](),
							}))}
						/>
					)}
					<PromptInputSubmit
						running={running}
						onStop={onStop}
						disabled={!text.trim()}
						busy={sending}
					/>
				</PromptInputFooter>
			</PromptInput>
			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
		</div>
	);
}

function Picker({
	label,
	value,
	onChange,
	items,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	items: { value: string; label: string }[];
}) {
	return (
		<Select items={items} value={value} onValueChange={(v) => v && onChange(v)}>
			<SelectTrigger
				size="sm"
				aria-label={label}
				className="border-0 shadow-none"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{items.map((item) => (
					<SelectItem key={item.value} value={item.value}>
						{item.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
