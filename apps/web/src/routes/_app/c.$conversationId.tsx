import type {
	AssistantMessage,
	Message as PiMessage,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ConversationEvent } from "@orqestra/api";
import {
	MEMORY_CHANGES,
	type MemoryChange as MemoryChangeName,
	messageText,
	parseSkillBlock,
} from "@orqestra/config/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	getRouteApi,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import {
	AlarmClockIcon,
	BotIcon,
	BrainIcon,
	CalendarClockIcon,
	ChevronRightIcon,
	DownloadIcon,
	EyeOffIcon,
	FileIcon,
	Loader2Icon,
	RotateCcwIcon,
	SquareIcon,
	Undo2Icon,
	WrenchIcon,
} from "lucide-react";
import {
	createContext,
	Fragment,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { MessageResponse } from "#/components/ai-elements/message";
import { Reasoning } from "#/components/ai-elements/reasoning";
import { type Choice, Composer } from "#/components/Composer";
import { FormSheet, useSheet } from "#/components/ConsolePage";
import { TaskForm } from "#/components/TaskForm";
import {
	Attachment,
	AttachmentContent,
	AttachmentDescription,
	AttachmentGroup,
	AttachmentMedia,
	AttachmentTitle,
	AttachmentTrigger,
} from "#/components/ui/attachment";
import { Badge } from "#/components/ui/badge";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Bubble, BubbleContent } from "#/components/ui/bubble";
import { Button } from "#/components/ui/button";
import {
	CodeBlock,
	CodeBlockContent,
	CodeBlockLine,
} from "#/components/ui/code-block";
import { Marker, MarkerContent } from "#/components/ui/marker";
import {
	Message,
	MessageContent,
	MessageFooter,
} from "#/components/ui/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "#/components/ui/message-scroller";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceDescription,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "#/components/ui/trace";
import { api, ok } from "#/lib/api";
import { nextFirings } from "#/lib/next-firing";
import { groupSteps } from "#/lib/steps";
import { summary, type TaskDraft, when } from "#/lib/tasks";
import { uploadFiles } from "#/lib/uploads";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export const Route = createFileRoute("/_app/c/$conversationId")({
	loader: async ({ params }) => {
		const { data, error } = await api()
			.api.conversations({ id: params.conversationId })
			.get();
		// another User's, or no Conversation's id at all
		if (error?.status === 404 || error?.status === 422) throw notFound();
		if (error) throw error;
		return data;
	},
	component: ConversationView,
});

const app = getRouteApi("/_app");

type Part = { kind: "text" | "thinking"; text: string };
/** Replies streaming to this tab, by subagent row id; the Conversation's own under "". */
type Live = Record<string, Part[]>;
/** What a Subagent's card or Notification needs: the live replies, and a way to open its panel. */
const PanelContext = createContext<{
	replies: Live;
	open: (run: SubagentTranscript) => void;
}>({ replies: {}, open: () => {} });

/**
 * The replies being generated, from the SSE stream: the Conversation's and its Subagents', each streaming at once.
 * Saved state reloads on (re)connect and on every `saved` or `end` event.
 */
function useLiveReplies(conversationId: string) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const [live, setLive] = useState<Live>({});
	useEffect(() => {
		// an open Subagent panel loads its transcript apart from the Conversation, so it reloads too
		const reload = () =>
			Promise.all([
				router.invalidate(),
				queryClient.invalidateQueries({ queryKey: ["subagent"] }),
				// a Run may have used up the Spending Limit, or failed on it
				queryClient.invalidateQueries({ queryKey: ["spending-limit"] }),
			]);
		const source = new EventSource(
			`/api/conversations/${conversationId}/events`,
		);
		// on (re)connect: load what is saved first, then follow the stream; an `end` missed meanwhile left a stale reply
		source.onopen = () => {
			setLive({});
			void reload();
		};
		// counts replies started per stream, so a reload finishing late keeps the reply that began meanwhile
		const started: Record<string, number> = {};
		source.onmessage = (e) => {
			const event = JSON.parse(e.data) as ConversationEvent;
			if (event.type === "saved") return void reload();
			const key = event.subagent ?? "";
			if (event.type === "start") {
				started[key] = (started[key] ?? 0) + 1;
				setLive((l) => ({ ...l, [key]: [] }));
			} else if (event.type === "delta")
				// shortcut: a reply that began before we connected shows from the next delta on; replaying it needs a server-side buffer
				setLive((l) => {
					const next = [...(l[key] ?? [])];
					const part = next[event.index] ?? { kind: event.kind, text: "" };
					next[event.index] = { ...part, text: part.text + event.delta };
					return { ...l, [key]: next };
				});
			else {
				const at = started[key];
				void reload().then(
					() => at === started[key] && setLive(({ [key]: _, ...rest }) => rest),
				);
			}
		};
		return () => source.close();
	}, [conversationId, router, queryClient]);
	return live;
}

/** A Conversation's or a Subagent's thread: follows the reply while it streams, and opens on the last question. */
function Thread({
	busy,
	className,
	children,
}: {
	busy: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
			<MessageScroller className="flex-1">
				<MessageScrollerViewport>
					<MessageScrollerContent aria-busy={busy} className={className}>
						{children}
					</MessageScrollerContent>
				</MessageScrollerViewport>
				<MessageScrollerButton />
			</MessageScroller>
		</MessageScrollerProvider>
	);
}

/** A Run or Subagent working, before its reply streams. */
const Working = () => (
	<TraceLine status="running">
		<TraceIcon>
			<Loader2Icon className="animate-spin text-signal" />
		</TraceIcon>
		<TraceTitle>{m.generating()}</TraceTitle>
	</TraceLine>
);

function ConversationView() {
	const conversation = Route.useLoaderData();
	const { agents } = app.useLoaderData();
	const router = useRouter();
	const replies = useLiveReplies(conversation.id);
	// a crashed Run never sends `end`: its reply stops showing with the status
	const live = conversation.status === "running" ? replies[""] : undefined;
	// kept on close so the panel keeps its content while it slides out
	const [panel, setPanel] = useState<{
		run: SubagentTranscript;
		open: boolean;
	}>();
	const running = conversation.status === "running";
	const draftSheet = useSheet<TaskDraft>();
	const lastUser = conversation.messages
		.filter((row) => row.message.role === "user")
		.at(-1);
	const results = toolResults(conversation.messages.map((row) => row.message));
	const delivered = conversation.messages.filter(
		// Tool results show under their call; one keeps its row only for the divider before it
		(row) =>
			!row.queued &&
			(row.message.role !== "toolResult" ||
				conversation.compactedBefore.includes(row.id)),
	);
	// still in the inbox: shown after the reply that is generating, and after a failure that awaits Retry
	const queued = conversation.messages.filter((row) => row.queued);
	// the reply whose Question waits for the User
	const asking = conversation.awaitingReply
		? delivered.filter((row) => row.message.role === "assistant").at(-1)?.id
		: undefined;
	const send = async ({
		files = [],
		...input
	}: {
		text: string;
		model?: string;
		thinking?: Choice["thinking"];
		files?: File[];
	}) => {
		const attachments = await uploadFiles(conversation.id, files);
		await ok(
			api().api.messages.post({
				...input,
				attachments,
				conversationId: conversation.id,
			}),
		);
		await router.invalidate();
	};

	// opening it, or a reply landing while it is open, is seeing it
	useEffect(() => {
		if (conversation.unread)
			void api()
				.api.conversations({ id: conversation.id })
				.seen.post()
				.then(() => router.invalidate());
	}, [conversation.id, conversation.unread, router]);

	return (
		<PanelContext
			value={{ replies, open: (run) => setPanel({ run, open: true }) }}
		>
			<div className="flex min-h-0 flex-1 flex-col">
				<Thread
					busy={running}
					className="mx-auto w-full max-w-3xl gap-6 px-4 py-6"
				>
					{conversation.incognito && (
						<MessageScrollerItem messageId="incognito" className="self-center">
							<Badge variant="outline">
								<EyeOffIcon />
								{m.incognito()}
							</Badge>
						</MessageScrollerItem>
					)}
					{delivered.map((row) => (
						<MessageScrollerItem
							key={row.id}
							messageId={String(row.id)}
							// the User's turn settles near the top, and the reply streams in under it
							scrollAnchor={
								row.message.role === "user" &&
								!row.subagentId &&
								!row.backgroundCallId
							}
							className="flex flex-col gap-6"
						>
							{conversation.compactedBefore.includes(row.id) && (
								<Marker variant="separator" className="text-xs">
									<MarkerContent>{m.compacted_divider()}</MarkerContent>
								</Marker>
							)}
							{row.origin === "timer" ? (
								<TimerRang />
							) : row.backgroundCallId ? (
								<BackgroundCallLine
									id={row.backgroundCallId}
									text={messageText(row.message)}
								/>
							) : row.message.role === "user" && row.subagentId ? (
								<NotificationLine
									run={conversation.subagents.find(
										(s) => s.id === row.subagentId,
									)}
									text={messageText(row.message)}
								/>
							) : row.message.role === "user" ? (
								<UserMessage message={row.message} />
							) : row.message.role === "assistant" ? (
								<AgentReply
									message={row.message}
									results={results}
									conversationId={conversation.id}
									// the drafting Turn's Agent, Model and thinking; Incognito as this Conversation is
									openDraft={(draft) =>
										draftSheet.show({
											...draft,
											agentId: conversation.agentId ?? "",
											model: row.model,
											thinking: row.thinkingLevel as TaskDraft["thinking"],
											incognito: conversation.incognito,
										})
									}
									answer={
										row.id === asking
											? (text) =>
													send({
														text,
														model: lastUser?.model,
														thinking:
															lastUser?.thinkingLevel as Choice["thinking"],
													})
											: undefined
									}
								/>
							) : null}
						</MessageScrollerItem>
					))}
					{live && (
						<MessageScrollerItem messageId="live">
							<LiveReply parts={live} />
						</MessageScrollerItem>
					)}
					{running && !live && (
						<MessageScrollerItem messageId="working">
							<Working />
						</MessageScrollerItem>
					)}
					{conversation.status === "failed" && (
						<MessageScrollerItem
							messageId="failed"
							className="flex items-center gap-2 text-sm text-destructive"
						>
							{conversation.failure === "spending_limit"
								? m.run_failed_spending_limit()
								: m.run_failed()}
							<RetryButton conversationId={conversation.id} />
						</MessageScrollerItem>
					)}
					{queued.map((row) => (
						<MessageScrollerItem
							key={`queued-${row.id}`}
							messageId={`queued-${row.id}`}
						>
							{row.origin === "timer" ? (
								<TimerRang />
							) : row.backgroundCallId ? (
								<BackgroundCallLine
									id={row.backgroundCallId}
									text={messageText(row.message)}
								/>
							) : row.subagentId ? (
								<NotificationLine
									run={conversation.subagents.find(
										(s) => s.id === row.subagentId,
									)}
									text={messageText(row.message)}
								/>
							) : (
								<UserMessage message={row.message} queued />
							)}
						</MessageScrollerItem>
					))}
					{conversation.timer && (
						<MessageScrollerItem messageId="timer">
							<TimerBar
								conversationId={conversation.id}
								note={conversation.timer.note}
								ringsAt={new Date(conversation.timer.ringsAt)}
							/>
						</MessageScrollerItem>
					)}
				</Thread>
				{conversation.readOnly ? (
					<p className="mx-auto w-full max-w-3xl px-4 pb-6 text-center text-sm text-muted-foreground">
						{m.agent_offline()}
					</p>
				) : (
					<Composer
						// remount when the Conversation changes so picks don't leak between them
						key={conversation.id}
						agents={agents}
						// null only for a Subagent's Conversation, which is read-only and shows no Composer
						agentId={conversation.agentId ?? ""}
						initial={
							lastUser && {
								model: lastUser.model,
								thinking: lastUser.thinkingLevel as Choice["thinking"],
							}
						}
						running={running}
						onStop={() =>
							void api().api.conversations({ id: conversation.id }).stop.post()
						}
						onSend={send}
					/>
				)}
			</div>
			<SubagentPanel
				// the panel follows the Subagent's saved state; older ones carry their own
				run={
					panel &&
					(conversation.subagents.find((s) => s.id === panel.run.id) ??
						panel.run)
				}
				open={!!panel?.open}
				onClose={() => setPanel((p) => p && { ...p, open: false })}
			/>
			<FormSheet
				open={draftSheet.open}
				onClose={draftSheet.close}
				title={m.task_new()}
			>
				{draftSheet.item && (
					<TaskForm
						draft={draftSheet.item}
						agents={agents.filter((a) => a.pickable)}
						onSaved={draftSheet.close}
					/>
				)}
			</FormSheet>
		</PanelContext>
	);
}

type Results = Map<string, ToolResultMessage>;

/** `busy` while `run`'s action is under way, so its button can't be pressed twice. */
function useBusy() {
	const [busy, setBusy] = useState(false);
	const run = async (action: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await action();
		} finally {
			setBusy(false);
		}
	};
	return [busy, run] as const;
}

/** Re-runs the last reply: a failed one, or one that asked a Question, which it withdraws. */
function RetryButton({ conversationId }: { conversationId: string }) {
	const router = useRouter();
	const [retrying, retry] = useBusy();
	return (
		<Button
			variant="outline"
			size="sm"
			disabled={retrying}
			onClick={() =>
				retry(async () => {
					await ok(
						api().api.conversations({ id: conversationId }).retry.post(),
					);
					await router.invalidate();
				})
			}
		>
			{retrying ? (
				<Loader2Icon className="animate-spin" data-icon="inline-start" />
			) : (
				<RotateCcwIcon data-icon="inline-start" />
			)}
			{m.retry()}
		</Button>
	);
}

/** An `ask_user` call the Agent made, unless it was refused. */
const questionOf = (call: ToolCall, result?: ToolResultMessage) =>
	call.name === "ask_user" && !result?.isError
		? (call.arguments as { question: string; suggestions?: string[] })
		: undefined;

type Drafted = Pick<TaskDraft, "name" | "prompt" | "schedule" | "endsAt">;

/** A `draft_scheduled_task` call the Agent made, once it was accepted. */
function draftOf(
	call: ToolCall,
	result?: ToolResultMessage,
): Drafted | undefined {
	if (call.name !== "draft_scheduled_task" || !result || result.isError)
		return undefined;
	const { ends_at, ...args } = call.arguments as Omit<Drafted, "endsAt"> & {
		ends_at?: string;
	};
	return { ...args, endsAt: ends_at ? new Date(ends_at) : null };
}

/** A Task Draft: what it would do and when, opening the drawer to create it; each save creates another task. */
function TaskDraftCard({
	draft,
	onOpen,
}: {
	draft: Drafted;
	onOpen: () => void;
}) {
	const [next] = nextFirings(
		draft.schedule,
		Intl.DateTimeFormat().resolvedOptions().timeZone,
	);
	return (
		<div className="flex flex-col gap-2 border-y py-3 text-sm">
			<p className="flex items-center gap-2 font-medium">
				<CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" />
				<span className="sr-only">{m.task_draft()}: </span>
				{draft.name}
			</p>
			<p className="whitespace-pre-wrap break-words text-muted-foreground">
				{draft.prompt}
			</p>
			<p className="text-xs text-muted-foreground">
				{summary(draft.schedule)}
				{next && ` · ${m.task_next({ time: when(next) })}`}
			</p>
			<Button
				size="sm"
				variant="outline"
				className="self-start"
				onClick={onOpen}
			>
				{m.task_draft_open()}
			</Button>
		</div>
	);
}

/** The Agent's Question; while it waits, its suggested answers are buttons that send their text, and Retry withdraws it. */
function Question({
	question,
	suggestions = [],
	answer,
	conversationId,
}: {
	question: string;
	suggestions?: string[];
	answer?: (text: string) => Promise<void>;
	conversationId?: string;
}) {
	const [sending, sendAnswer] = useBusy();
	return (
		<div className="flex flex-col items-start gap-3">
			<MessageResponse>{question}</MessageResponse>
			{answer && conversationId && (
				<div className="flex flex-wrap gap-2">
					{suggestions.map((s) => (
						<Button
							key={s}
							variant="outline"
							size="sm"
							disabled={sending}
							onClick={() => sendAnswer(() => answer(s))}
						>
							{s}
						</Button>
					))}
					<RetryButton conversationId={conversationId} />
				</div>
			)}
		</div>
	);
}

/** A User's message; one that invoked a Skill shows its name, not the instructions put in for it. */
function UserText({ text }: { text: string }) {
	const skill = parseSkillBlock(text);
	if (!skill) return text;
	return (
		<div className="flex flex-col items-start gap-1.5">
			<Badge variant="outline">{m.skill_used({ name: skill.name })}</Badge>
			{skill.text}
		</div>
	);
}

const toolResults = (messages: PiMessage[]): Results =>
	new Map(
		messages
			.filter((m): m is ToolResultMessage => m.role === "toolResult")
			.map((m) => [m.toolCallId, m]),
	);

/** One Subagent's process: a subagent row, or one kept in the Tool result's details by Runs from before the subagent table. */
type SubagentTranscript = {
	id?: string;
	// the Conversation that started it: the root's, or another Subagent's
	parentId?: string;
	number?: number;
	template?: string | null;
	brief: string;
	// only older ones carry their transcript; a row's loads when its panel opens
	messages?: PiMessage[];
	outcome?: (typeof Route.types.loaderData)["subagents"][number]["outcome"];
};

const outcomeLabel = (outcome = "completed") =>
	(
		({
			queued: m.subagent_queued(),
			running: m.generating(),
			completed: m.subagent_completed(),
			partial: m.subagent_partial(),
			failed: m.subagent_failed(),
			stopped: m.subagent_stopped(),
		}) as Record<string, string>
	)[outcome];

function useSubagentName(run?: SubagentTranscript) {
	const { agents } = app.useLoaderData();
	return run?.template
		? (agents.find((a) => a.id === run.template)?.name ?? run.template)
		: m.general_worker();
}

const units = ["byte", "kilobyte", "megabyte", "gigabyte"];
/** 12 B, 3.4 MB… in the User's locale. */
function fileSize(bytes: number) {
	const power = Math.min(
		Math.floor(Math.log10(Math.max(bytes, 1)) / 3),
		units.length - 1,
	);
	return new Intl.NumberFormat(getLocale(), {
		style: "unit",
		unit: units[power],
		unitDisplay: "short",
		maximumFractionDigits: 1,
	}).format(bytes / 1000 ** power);
}

type FileAttachment = { path: string; name: string; size: number };
/** The file an `attach` call put in the Sandbox, if it did. */
const attachmentOf = (call: ToolCall, result?: ToolResultMessage) =>
	call.name === "attach"
		? (result?.details as { attachment?: FileAttachment } | undefined)
				?.attachment
		: undefined;

/** A file the Agent attached, as a download; a tab of its own, so a download that fails shows why there. */
function FileDownload({
	attachment,
	conversationId,
}: {
	attachment: FileAttachment;
	conversationId: string;
}) {
	const [error, setError] = useState<string>();
	const href = `/api/conversations/${conversationId}/files?${new URLSearchParams({ name: attachment.name })}`;
	return (
		<Attachment size="sm">
			<AttachmentMedia>
				<FileIcon />
			</AttachmentMedia>
			<AttachmentContent>
				<AttachmentTitle>{attachment.name}</AttachmentTitle>
				<AttachmentDescription className={cn(error && "text-destructive")}>
					{error ?? fileSize(attachment.size)}
				</AttachmentDescription>
			</AttachmentContent>
			<DownloadIcon className="mr-1 size-4 text-muted-foreground" />
			<AttachmentTrigger
				render={
					// biome-ignore lint/a11y/useAnchorContent: labelled by aria-label; the visible name sits beside it
					<a
						href={href}
						aria-label={m.file_download({ name: attachment.name })}
						// asked first, so the User reads why a file cannot be had; the api answers its code as JSON
						onClick={async (e) => {
							e.preventDefault();
							setError(undefined);
							const response = await fetch(href).catch(() => undefined);
							if (response?.ok) {
								await response.body?.cancel();
								// an attachment: the browser saves it and stays on the page
								location.assign(href);
								return;
							}
							const code: string | undefined = await response?.json().then(
								(b) => b.errors?.file?.code,
								() => undefined,
							);
							setError(
								(code === "not_found" ? m.file_not_found : m.request_failed)(),
							);
						}}
					/>
				}
			/>
		</Attachment>
	);
}

/** A Tool call as one Trace line (name and arguments); once its result is in, the line opens on it. */
function ToolCallView({
	call,
	result,
	conversationId,
}: {
	call: ToolCall;
	result?: ToolResultMessage;
	conversationId?: string;
}) {
	const { subagents, backgroundCalls } = Route.useLoaderData();
	const background = backgroundCalls.find((b) => b.toolCallId === call.id);
	const runs =
		(result?.details as { subagents?: SubagentTranscript[] } | undefined)
			?.subagents ?? subagents.filter((s) => s.toolCallId === call.id);
	if (call.name === "subagent" && runs.length)
		return runs.map((run, i) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: saved runs never reorder
			<SubagentView key={i} run={run} />
		));
	if (
		MEMORY_CHANGES.includes(call.name as MemoryChangeName) &&
		result?.details &&
		!result.isError &&
		conversationId
	)
		return (
			<MemoryChange
				call={call}
				result={result}
				conversationId={conversationId}
			/>
		);
	// a call its MCP Server put in the background goes on past its result
	const pending = !result || background?.status === "running";
	const line = (
		<TraceLine
			status={
				pending
					? "running"
					: result?.isError || background?.status === "failed"
						? "error"
						: undefined
			}
		>
			<TraceIcon>
				{pending ? (
					<Loader2Icon className="animate-spin text-signal" />
				) : (
					<WrenchIcon />
				)}
			</TraceIcon>
			<TraceTitle>{call.name}</TraceTitle>
			<TraceDescription className="min-w-0 shrink truncate">
				{background
					? backgroundCallLabel(background.status)
					: Object.values(call.arguments).map(String).join(" · ")}
			</TraceDescription>
		</TraceLine>
	);
	if (!result) return line;
	const view = (
		<TraceCollapsible>
			<TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
			<TraceCollapsibleContent>
				<CodeBlock
					size="sm"
					variant={result.isError ? "destructive" : "default"}
				>
					<CodeBlockContent wrap className="max-h-64">
						{messageText(result)}
					</CodeBlockContent>
				</CodeBlock>
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
	if (background?.status !== "running") return view;
	return (
		<div className="flex items-start gap-2">
			<div className="min-w-0 flex-1">{view}</div>
			<CancelBackgroundCall toolCallId={call.id} />
		</div>
	);
}

/** Cancels a Background Call still running, at the User's request; the Agent hears of it with the next message. */
function CancelBackgroundCall({ toolCallId }: { toolCallId: string }) {
	const router = useRouter();
	// the page's top-level Conversation: it finds the call in its Subagents too
	const { conversationId } = Route.useParams();
	const [cancelling, cancel] = useBusy();
	return (
		<Button
			variant="ghost"
			size="sm"
			disabled={cancelling}
			onClick={() =>
				cancel(async () => {
					await ok(
						api()
							.api.conversations({ id: conversationId })
							["background-calls"]({ toolCallId })
							.delete(),
					);
					await router.invalidate();
				})
			}
		>
			{m.background_call_cancel()}
		</Button>
	);
}

type MemoryContent = { description: string; body: string };
const memoryLabels = {
	memory_write: m.memory_saved,
	memory_edit: m.memory_updated,
	memory_delete: m.memory_forgotten,
} satisfies Record<MemoryChangeName, unknown>;

/** A Memory the Agent wrote, edited or deleted, as a Trace line in its reply; open it for the content and to undo it. */
function MemoryChange({
	call,
	result,
	conversationId,
}: {
	call: ToolCall;
	result: ToolResultMessage;
	conversationId: string;
}) {
	const router = useRouter();
	const [undoing, setUndoing] = useState(false);
	const [error, setError] = useState<string>();
	const change = result.details as {
		path: string;
		before?: MemoryContent;
		after?: MemoryContent;
		old?: string;
		new?: string;
		undone?: boolean;
	};
	const description = (change.after ?? change.before)?.description ?? "";
	const label = memoryLabels[call.name as MemoryChangeName]({ description });
	return (
		<TraceCollapsible>
			<TraceCollapsibleTrigger>
				<TraceLine>
					<TraceIcon>
						<BrainIcon />
					</TraceIcon>
					<TraceTitle className={cn(change.undone && "line-through")}>
						{label}
					</TraceTitle>
					{change.undone && (
						<TraceDescription>{m.memory_undone()}</TraceDescription>
					)}
				</TraceLine>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="flex flex-col items-start gap-2">
				<span className="font-mono text-xs">{change.path}</span>
				<CodeBlock size="sm">
					<CodeBlockContent wrap className="max-h-64">
						{call.name === "memory_edit" ? (
							<>
								<CodeBlockLine variant="removed">{change.old}</CodeBlockLine>
								<CodeBlockLine variant="added">{change.new}</CodeBlockLine>
							</>
						) : (
							(change.after ?? change.before)?.body
						)}
					</CodeBlockContent>
				</CodeBlock>
				{!change.undone && (
					<Button
						variant="outline"
						size="sm"
						disabled={undoing}
						onClick={async () => {
							setUndoing(true);
							setError(undefined);
							try {
								const { error } = await api()
									.api.conversations({ id: conversationId })
									["memory-undo"].post({ toolCallId: call.id });
								const code =
									error?.status === 422 && error.value.errors.toolCallId?.code;
								if (error)
									setError(
										code === "changed"
											? m.memory_undo_changed()
											: code === "full"
												? m.memory_undo_full()
												: m.memory_undo_failed(),
									);
								await router.invalidate();
							} finally {
								setUndoing(false);
							}
						}}
					>
						{undoing ? (
							<Loader2Icon className="animate-spin" data-icon="inline-start" />
						) : (
							<Undo2Icon data-icon="inline-start" />
						)}
						{m.memory_undo()}
					</Button>
				)}
				{error && <p className="text-xs text-destructive">{error}</p>}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

/** A Subagent as one Trace line in its parent's reply, with what it is writing; open it for its own Conversation. */
function SubagentView({ run }: { run: SubagentTranscript }) {
	const { replies, open } = useContext(PanelContext);
	const name = useSubagentName(run);
	const running = run.outcome === "running";
	// a crashed Run never sends `end`: its reply stops showing with its outcome
	const live = running && run.id ? replies[run.id] : undefined;
	const preview = live?.at(-1)?.text.trim().split("\n").at(-1);
	return (
		<button type="button" onClick={() => open(run)}>
			<TraceLine
				status={
					running ? "running" : run.outcome === "failed" ? "error" : undefined
				}
			>
				<TraceIcon>
					{running ? (
						<Loader2Icon className="animate-spin text-signal" />
					) : (
						<BotIcon />
					)}
				</TraceIcon>
				<TraceTitle>
					{name} · {run.brief}
				</TraceTitle>
				<TraceDescription className="min-w-0 shrink truncate">
					{running ? (preview ?? m.generating()) : outcomeLabel(run.outcome)}
				</TraceDescription>
				<TraceIcon>
					<ChevronRightIcon />
				</TraceIcon>
			</TraceLine>
		</button>
	);
}

/** A Subagent's Notification to its parent, as one divider: which one, and how it ended. */
function NotificationLine({
	run,
	text,
}: {
	run?: SubagentTranscript & { number: number };
	text: string;
}) {
	const { open } = useContext(PanelContext);
	// how it ended this time: a continued Subagent notifies again
	const outcome = text.match(/^<task-notification [^>]*status="(\w+)"/)?.[1];
	if (!run) return null;
	return (
		<Marker
			variant="separator"
			className="text-xs hover:text-foreground"
			render={<button type="button" onClick={() => open(run)} />}
		>
			<MarkerContent>
				{m.subagent_number({ number: run.number })} · {outcomeLabel(outcome)}
			</MarkerContent>
		</Marker>
	);
}

const backgroundCallLabel = (status?: string) =>
	(
		({
			running: m.background_call_running(),
			completed: m.background_call_completed(),
			failed: m.background_call_failed(),
			cancelled: m.background_call_cancelled(),
		}) as Record<string, string>
	)[status ?? "completed"];

/** A Background Call's Notification, as one divider like a Subagent's: its MCP Server and Tool, and how it ended. */
function BackgroundCallLine({ id, text }: { id: string; text: string }) {
	const call = Route.useLoaderData().backgroundCalls.find((b) => b.id === id);
	const outcome = text.match(/^<task-notification [^>]*status="(\w+)"/)?.[1];
	if (!call) return null;
	return (
		<Marker variant="separator" className="text-xs">
			<MarkerContent>
				{call.mcpServerName} · {call.toolName} · {backgroundCallLabel(outcome)}
			</MarkerContent>
		</Marker>
	);
}

/** Where the Agent's Timer rang: its note, written to the Agent, came in as the next input. */
const TimerRang = () => (
	<Marker variant="separator" className="text-xs">
		<MarkerContent>
			<AlarmClockIcon className="size-3" />
			{m.timer_rang()}
		</MarkerContent>
	</Marker>
);

/** The Timer the Agent set: when it rings and its note, with a button to cancel it. */
function TimerBar({
	conversationId,
	note,
	ringsAt,
}: {
	conversationId: string;
	note: string;
	ringsAt: Date;
}) {
	const router = useRouter();
	const [cancelling, cancel] = useBusy();
	// a time of day today, with the date beyond it
	const time = ringsAt.toLocaleString(getLocale(), {
		...(ringsAt.toDateString() === new Date().toDateString()
			? {}
			: { month: "short", day: "numeric" }),
		hour: "2-digit",
		minute: "2-digit",
	});
	return (
		<div className="flex items-center gap-2 border-t pt-3 text-sm text-muted-foreground">
			<AlarmClockIcon className="size-4 shrink-0" />
			<span className="min-w-0 flex-1 break-words">
				{m.timer_set({ time, note })}
			</span>
			<Button
				variant="ghost"
				size="sm"
				disabled={cancelling}
				onClick={() =>
					cancel(async () => {
						await ok(
							api().api.conversations({ id: conversationId }).timer.delete(),
						);
						await router.invalidate();
					})
				}
			>
				{m.timer_cancel()}
			</Button>
		</div>
	);
}

/** A Subagent's own Conversation, read-only: the User can stop it, but only the Agent that started it writes to it. */
function SubagentPanel({
	run,
	open,
	onClose,
}: {
	run?: SubagentTranscript;
	open: boolean;
	onClose: () => void;
}) {
	const router = useRouter();
	const { title: rootTitle, subagents } = Route.useLoaderData();
	const { replies, open: openPanel } = useContext(PanelContext);
	const name = useSubagentName(run);
	const [stopping, setStopping] = useState(false);
	// the Subagents it sits under, outermost first, for the breadcrumb
	const trail: typeof subagents = [];
	for (
		let at = subagents.find((s) => s.id === run?.parentId);
		at;
		at = subagents.find((s) => s.id === at?.parentId)
	)
		trail.unshift(at);
	// focus lands on the title, not on Stop, so a stray Enter does not stop the Subagent
	const title = useRef<HTMLHeadingElement>(null);
	const id = run?.id;
	const loaded = useQuery({
		queryKey: ["subagent", id],
		queryFn: () =>
			ok(
				api()
					.api.subagents({ id: id as string })
					.get(),
			),
		enabled: open && !!id && !run?.messages,
	});
	const messages = run?.messages ?? loaded.data ?? [];
	const results = toolResults(messages);
	const running = run?.outcome === "running";
	const live = running && id ? replies[id] : undefined;
	const active = running || run?.outcome === "queued";
	return (
		<Sheet open={open} onOpenChange={(o) => !o && onClose()}>
			<SheetContent
				className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
				initialFocus={title}
			>
				<SheetHeader className="flex-row items-center gap-3 border-b pr-12">
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						{run?.number !== undefined && (
							<Breadcrumb>
								<BreadcrumbList>
									<BreadcrumbItem className="min-w-0">
										<BreadcrumbLink
											className="truncate"
											render={<button type="button" onClick={onClose} />}
										>
											{rootTitle ?? m.untitled_conversation()}
										</BreadcrumbLink>
									</BreadcrumbItem>
									{trail.map((s) => (
										<Fragment key={s.id}>
											<BreadcrumbSeparator />
											<BreadcrumbItem>
												<BreadcrumbLink
													render={
														<button
															type="button"
															onClick={() => openPanel(s)}
														/>
													}
												>
													{m.subagent_number({ number: s.number })}
												</BreadcrumbLink>
											</BreadcrumbItem>
										</Fragment>
									))}
									<BreadcrumbSeparator />
									<BreadcrumbItem>
										<BreadcrumbPage>
											{m.subagent_number({ number: run.number })}
										</BreadcrumbPage>
									</BreadcrumbItem>
								</BreadcrumbList>
							</Breadcrumb>
						)}
						<SheetTitle ref={title} tabIndex={-1} className="outline-none">
							{name}
						</SheetTitle>
						<SheetDescription>
							{run?.number !== undefined &&
								`${m.subagent_number({ number: run.number })} · `}
							{outcomeLabel(run?.outcome)}
						</SheetDescription>
					</div>
					{active && id && (
						<Button
							variant="outline"
							size="sm"
							disabled={stopping}
							onClick={async () => {
								setStopping(true);
								try {
									await ok(api().api.subagents({ id }).stop.post());
									await router.invalidate();
								} finally {
									setStopping(false);
								}
							}}
						>
							{stopping ? (
								<Loader2Icon
									className="animate-spin"
									data-icon="inline-start"
								/>
							) : (
								<SquareIcon data-icon="inline-start" />
							)}
							{m.stop_subagent()}
						</Button>
					)}
				</SheetHeader>
				<Thread busy={active} className="gap-6 px-4 pb-6">
					<MessageScrollerItem messageId="brief" scrollAnchor>
						<Message align="end">
							<MessageContent>
								<UserBubble>{run?.brief}</UserBubble>
							</MessageContent>
						</Message>
					</MessageScrollerItem>
					{messages.map((message, i) =>
						message.role === "assistant" ? (
							// biome-ignore lint/suspicious/noArrayIndexKey: saved messages never reorder
							<MessageScrollerItem key={i} messageId={String(i)}>
								<AgentReply
									message={message}
									results={results}
									conversationId={id}
								/>
							</MessageScrollerItem>
						) : message.role === "user" &&
							messageText(message).startsWith("<task-notification") ? (
							// a Notification from one of its own Subagents, which open from here too
							// biome-ignore lint/suspicious/noArrayIndexKey: saved messages never reorder
							<MessageScrollerItem key={i} messageId={String(i)}>
								<NotificationLine
									run={subagents.find(
										(s) =>
											s.parentId === id &&
											s.number ===
												Number(
													messageText(message).match(/subagent="(\d+)"/)?.[1],
												),
									)}
									text={messageText(message)}
								/>
							</MessageScrollerItem>
						) : message.role === "user" && i > 0 ? (
							// messages the parent sent while it worked; the first is the brief, shown above
							<MessageScrollerItem
								// biome-ignore lint/suspicious/noArrayIndexKey: saved messages never reorder
								key={i}
								messageId={String(i)}
								scrollAnchor
							>
								<Message align="end">
									<MessageContent>
										<UserBubble>{messageText(message)}</UserBubble>
									</MessageContent>
								</Message>
							</MessageScrollerItem>
						) : null,
					)}
					{live && (
						<MessageScrollerItem messageId="live">
							<LiveReply parts={live} />
						</MessageScrollerItem>
					)}
					{(run?.outcome === "queued" ||
						(running && !live) ||
						(loaded.isFetching && !loaded.data)) && (
						<MessageScrollerItem messageId="working">
							<Working />
						</MessageScrollerItem>
					)}
				</Thread>
			</SheetContent>
		</Sheet>
	);
}

/** The User's side of a turn, sized as DESIGN.md sets it. */
function UserBubble({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	return (
		<Bubble align="end" variant="muted">
			<BubbleContent
				className={cn(
					"rounded-2xl px-4 py-2.5 text-base whitespace-pre-wrap",
					className,
				)}
			>
				{children}
			</BubbleContent>
		</Bubble>
	);
}

/** A User message: its text, and the names of its attachments, whose paths a second text gives the Agent. */
function UserMessage({
	message,
	queued,
}: {
	message: PiMessage;
	/** Still in the inbox. */
	queued?: boolean;
}) {
	const { attachments } = message as {
		attachments?: { name: string; path: string }[];
	};
	const first = Array.isArray(message.content) ? message.content[0] : undefined;
	return (
		<Message align="end">
			<MessageContent>
				<UserBubble className={queued ? "opacity-60" : undefined}>
					<UserText
						text={
							attachments && first?.type === "text"
								? first.text
								: messageText(message)
						}
					/>
				</UserBubble>
				{attachments && (
					<AttachmentGroup aria-label={m.attachments()} role="list">
						{attachments.map((a) => (
							<Attachment key={a.path} size="xs" role="listitem">
								<AttachmentMedia>
									<FileIcon />
								</AttachmentMedia>
								<AttachmentContent>
									<AttachmentTitle>{a.name}</AttachmentTitle>
								</AttachmentContent>
							</Attachment>
						))}
					</AttachmentGroup>
				)}
				{queued && <MessageFooter>{m.queued()}</MessageFooter>}
			</MessageContent>
		</Message>
	);
}

function AgentReply({
	message,
	results,
	conversationId,
	answer,
	openDraft,
}: {
	message: AssistantMessage;
	results: Results;
	/** Opens a Task Draft's drawer; only the top-level Agent drafts. */
	openDraft?: (draft: Drafted) => void;
	/** Whose Sandbox the files it attached are in; older Subagents kept in a Tool result have none. */
	conversationId?: string;
	/** Sends the User's answer to its Question, while it waits for one. */
	answer?: (text: string) => Promise<void>;
}) {
	const download = (part: AssistantMessage["content"][number]) =>
		part.type === "toolCall" && conversationId
			? attachmentOf(part, results.get(part.id))
			: undefined;
	const asked = (part: AssistantMessage["content"][number]) =>
		part.type === "toolCall"
			? questionOf(part, results.get(part.id))
			: undefined;
	const drafted = (part: AssistantMessage["content"][number]) =>
		part.type === "toolCall" && openDraft
			? draftOf(part, results.get(part.id))
			: undefined;
	return (
		<Message>
			<MessageContent className="gap-3">
				{groupSteps(
					message.content,
					(part) =>
						part.type !== "text" &&
						!download(part) &&
						!asked(part) &&
						!drafted(part),
				).map((run, i) => {
					if (Array.isArray(run))
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: saved content never reorders
							<Trace key={i}>
								{run.map((part, j) =>
									part.type === "thinking" ? (
										// biome-ignore lint/suspicious/noArrayIndexKey: saved content never reorders
										<Reasoning key={j} text={part.thinking} />
									) : part.type === "toolCall" ? (
										<ToolCallView
											key={part.id}
											call={part}
											result={results.get(part.id)}
											conversationId={conversationId}
										/>
									) : null,
								)}
							</Trace>
						);
					const question = asked(run);
					if (question)
						return (
							<Question
								// biome-ignore lint/suspicious/noArrayIndexKey: saved content never reorders
								key={i}
								{...question}
								answer={answer}
								conversationId={conversationId}
							/>
						);
					const draft = drafted(run);
					if (draft && openDraft)
						return (
							<TaskDraftCard
								// biome-ignore lint/suspicious/noArrayIndexKey: saved content never reorders
								key={i}
								draft={draft}
								onOpen={() => openDraft(draft)}
							/>
						);
					const attachment = download(run);
					if (attachment && conversationId)
						return (
							<FileDownload
								// biome-ignore lint/suspicious/noArrayIndexKey: saved content never reorders
								key={i}
								attachment={attachment}
								conversationId={conversationId}
							/>
						);
					return run.type === "text" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: saved content never reorders
						<MessageResponse key={i}>{run.text}</MessageResponse>
					) : null;
				})}
				{message.stopReason === "aborted" && (
					<p className="text-xs text-muted-foreground">{m.stopped()}</p>
				)}
				{message.stopReason === "error" && (
					<p className="text-sm text-destructive">
						{message.errorMessage ?? m.run_failed()}
					</p>
				)}
			</MessageContent>
		</Message>
	);
}

function LiveReply({ parts }: { parts: Part[] }) {
	const last = parts.length - 1;
	return (
		<Message>
			<MessageContent className="gap-3">
				{groupSteps(
					// a delta can arrive for a later index first, leaving holes
					parts.flatMap((part, i) => (part ? [{ ...part, i }] : [])),
					(part) => part.kind === "thinking",
				).map((run) =>
					Array.isArray(run) ? (
						<Trace key={run[0].i}>
							{run.map((part) => (
								<Reasoning
									key={part.i}
									text={part.text}
									isStreaming={part.i === last}
								/>
							))}
						</Trace>
					) : (
						<MessageResponse key={run.i} isAnimating mode="streaming">
							{run.text}
						</MessageResponse>
					),
				)}
			</MessageContent>
		</Message>
	);
}
