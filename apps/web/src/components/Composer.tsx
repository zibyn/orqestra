import { invokedSkill, MAX_UPLOAD_BYTES } from "@orqestra/config/shared";
import { FileIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import {
	PromptInput,
	PromptInputFooter,
	PromptInputHeader,
	PromptInputMenu,
	PromptInputSubmit,
	PromptInputTextarea,
} from "#/components/ai-elements/prompt-input";
import {
	Attachment,
	AttachmentAction,
	AttachmentActions,
	AttachmentContent,
	AttachmentMedia,
	AttachmentTitle,
} from "#/components/ui/attachment";
import { InputGroupButton } from "#/components/ui/input-group";
import type { Api } from "#/lib/api";
import { tooLarge, UploadError } from "#/lib/uploads";
import { m } from "#/paraglide/messages";

export type AgentOption = NonNullable<
	Awaited<ReturnType<Api["api"]["agent-options"]["get"]>>["data"]
>[number];
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

/**
 * Message input with the Agent (new Conversations only), Model and thinking pickers; a picker with one option is hidden.
 * Agents with a Sandbox take attachments, which `onSend` uploads.
 */
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
	onSend: (
		message: Required<Choice> & { text: string; files: File[] },
	) => Promise<unknown>;
	onStop: () => void;
}) {
	const [text, setText] = useState("");
	const [files, setFiles] = useState<File[]>([]);
	const picker = useRef<HTMLInputElement>(null);
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
	// picked for an Agent with a Sandbox, then another picked: they stay out of the message
	const attached = agent.attachments ? files : [];
	// `/` then the start of `skill:name`, before any space, lists the Skills it matches
	const typed = /^\/(\S*)$/.exec(text)?.[1];
	const matches =
		typed === undefined
			? []
			: agent.skills.filter((s) => `skill:${s.name}`.startsWith(typed));
	const [active, setActive] = useState(0);
	const highlighted = matches[Math.min(active, matches.length - 1)];
	const pick = (name: string) => setText(`/skill:${name} `);

	return (
		<div className="mx-auto w-full max-w-3xl px-4 pb-4">
			<PromptInput
				onSubmit={async (e) => {
					e.preventDefault();
					// sent while running, it waits in the inbox for the next step boundary
					if (!text.trim() || sending) return;
					// pi would refuse it as sent; say why here instead
					const skill = invokedSkill(text);
					if (skill && !agent.skills.some((s) => s.name === skill.name)) {
						setError(m.skill_not_usable({ name: skill.name }));
						return;
					}
					setSending(true);
					setError("");
					try {
						await onSend({ text, model: model.ref, thinking, files: attached });
						setText("");
						setFiles([]);
					} catch (e) {
						setError(e instanceof UploadError ? e.message : m.request_failed());
					} finally {
						setSending(false);
					}
				}}
			>
				{highlighted && (
					<PromptInputHeader
						id="composer-skills"
						role="listbox"
						aria-label={m.composer_skills()}
						className="flex-col items-stretch gap-0 border-b px-1 py-1"
					>
						{matches.map((s) => (
							<button
								key={s.name}
								id={`composer-skill-${s.name}`}
								type="button"
								role="option"
								aria-selected={s === highlighted}
								tabIndex={-1}
								className="flex flex-col items-start rounded-md px-2 py-1.5 text-left font-normal text-foreground aria-selected:bg-accent"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => pick(s.name)}
							>
								<span className="font-medium">/skill:{s.name}</span>
								<span className="line-clamp-1 text-muted-foreground text-xs">
									{s.description}
								</span>
							</button>
						))}
					</PromptInputHeader>
				)}
				<PromptInputTextarea
					aria-label={m.composer_placeholder()}
					placeholder={m.composer_placeholder()}
					value={text}
					role={highlighted ? "combobox" : undefined}
					aria-expanded={highlighted ? true : undefined}
					aria-controls={highlighted ? "composer-skills" : undefined}
					aria-activedescendant={
						highlighted ? `composer-skill-${highlighted.name}` : undefined
					}
					onChange={(e) => {
						setText(e.target.value);
						setActive(0);
					}}
					onKeyDown={(e) => {
						if (!highlighted || e.nativeEvent.isComposing) return;
						const i = matches.indexOf(highlighted);
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							e.preventDefault();
							const step = e.key === "ArrowDown" ? 1 : -1;
							setActive((i + step + matches.length) % matches.length);
						} else if (e.key === "Enter" || e.key === "Tab") {
							// picks the Skill instead of sending
							e.preventDefault();
							pick(highlighted.name);
						}
					}}
				/>
				{attached.length > 0 && (
					<PromptInputHeader aria-label={m.attachments()} role="list">
						{attached.map((file, i) => (
							<Attachment
								// biome-ignore lint/suspicious/noArrayIndexKey: two picks of one file share every other key
								key={i}
								size="sm"
								role="listitem"
								className="max-w-56"
							>
								<AttachmentMedia>
									<FileIcon />
								</AttachmentMedia>
								<AttachmentContent>
									<AttachmentTitle>{file.name}</AttachmentTitle>
								</AttachmentContent>
								<AttachmentActions>
									<AttachmentAction
										aria-label={m.remove_attachment({ name: file.name })}
										onClick={() => setFiles(files.filter((f) => f !== file))}
									>
										<XIcon />
									</AttachmentAction>
								</AttachmentActions>
							</Attachment>
						))}
					</PromptInputHeader>
				)}
				<PromptInputFooter>
					{agent.attachments && (
						<>
							<input
								ref={picker}
								type="file"
								multiple
								hidden
								onChange={(e) => {
									const picked = [...(e.target.files ?? [])];
									e.target.value = "";
									const big = picked.find((f) => f.size > MAX_UPLOAD_BYTES);
									setError(big ? tooLarge(big) : "");
									setFiles([
										...files,
										...picked.filter((f) => f.size <= MAX_UPLOAD_BYTES),
									]);
								}}
							/>
							<InputGroupButton
								size="icon-sm"
								variant="outline"
								className="rounded-full"
								aria-label={m.attach_files()}
								onClick={() => picker.current?.click()}
							>
								<PlusIcon />
							</InputGroupButton>
						</>
					)}
					{onAgentChange && agents.length > 1 && (
						<PromptInputMenu
							label={m.agent()}
							value={agent.id}
							onChange={onAgentChange}
							items={agents.map((a) => ({ value: a.id, label: a.name }))}
						/>
					)}
					{/* the message's own picks sit by Send */}
					<div className="ml-auto flex items-center gap-1">
						{agent.models.length > 1 && (
							<PromptInputMenu
								label={m.agent_models()}
								value={model.ref}
								onChange={(ref) => setPicked({ ...picked, model: ref })}
								items={agent.models.map((x) => ({
									value: x.ref,
									label: x.name,
								}))}
							/>
						)}
						{model.thinking.allowed.length > 1 && (
							<PromptInputMenu
								label={m.thinking_level()}
								showLabel
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
					</div>
				</PromptInputFooter>
			</PromptInput>
			{error && <p className="mt-2 text-sm text-destructive">{error}</p>}
		</div>
	);
}
