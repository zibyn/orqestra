import type {
	AssistantMessage,
	Message as PiMessage,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { messageText } from "@orqestra/config/shared";
import type { ConversationEvent } from "@orqestra/db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	getRouteApi,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import {
	ChevronRightIcon,
	Loader2Icon,
	RotateCcwIcon,
	SquareIcon,
} from "lucide-react";
import {
	createContext,
	Fragment,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	Message,
	MessageContent,
	MessageResponse,
} from "#/components/ai-elements/message";
import { Reasoning } from "#/components/ai-elements/reasoning";
import { type Choice, Composer } from "#/components/Composer";
import { Button } from "#/components/ui/button";
import { Separator } from "#/components/ui/separator";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import {
	getConversation,
	getSubagentMessages,
	retryRun,
	sendMessage,
	stopRun,
	stopSubagent,
} from "#/lib/conversation-fns";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/_app/c/$conversationId")({
	loader: async ({ params }) => {
		const conversation = await getConversation({
			data: params.conversationId,
		});
		if (!conversation) throw notFound();
		return conversation;
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

function ConversationView() {
	const conversation = Route.useLoaderData();
	const { agents } = app.useLoaderData();
	const router = useRouter();
	const replies = useLiveReplies(conversation.id);
	// a crashed Run never sends `end`: its reply stops showing with the status
	const live = conversation.status === "running" ? replies[""] : undefined;
	const [retrying, setRetrying] = useState(false);
	// kept on close so the panel keeps its content while it slides out
	const [panel, setPanel] = useState<{
		run: SubagentTranscript;
		open: boolean;
	}>();
	const running = conversation.status === "running";
	const lastUser = conversation.messages
		.filter((row) => row.message.role === "user")
		.at(-1);
	const results = toolResults(conversation.messages.map((row) => row.message));
	const delivered = conversation.messages.filter((row) => !row.queued);
	// still in the inbox: shown after the reply that is generating, and after a failure that awaits Retry
	const queued = conversation.messages.filter((row) => row.queued);

	return (
		<PanelContext
			value={{ replies, open: (run) => setPanel({ run, open: true }) }}
		>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex-1 overflow-y-auto">
					<div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
						{delivered.map((row) => (
							<Fragment key={row.id}>
								{conversation.compactedBefore.includes(row.id) && (
									<div className="flex items-center gap-3 text-xs text-muted-foreground">
										<Separator className="flex-1" />
										{m.compacted_divider()}
										<Separator className="flex-1" />
									</div>
								)}
								{
									row.message.role === "user" && row.subagentId ? (
										<NotificationLine
											subagentId={row.subagentId}
											text={messageText(row.message)}
										/>
									) : row.message.role === "user" ? (
										<Message from="user">
											<MessageContent>
												{messageText(row.message)}
											</MessageContent>
										</Message>
									) : row.message.role === "assistant" ? (
										<AgentReply message={row.message} results={results} />
									) : null /* Tool results show under their call */
								}
							</Fragment>
						))}
						{live && <LiveReply parts={live} />}
						{running && !live && (
							<Loader2Icon
								aria-label={m.generating()}
								className="size-4 animate-spin text-muted-foreground"
							/>
						)}
						{conversation.status === "failed" && (
							<div className="flex items-center gap-2 text-sm text-destructive">
								{m.run_failed()}
								<Button
									variant="outline"
									size="sm"
									disabled={retrying}
									onClick={async () => {
										setRetrying(true);
										try {
											await retryRun({ data: conversation.id });
											await router.invalidate();
										} finally {
											setRetrying(false);
										}
									}}
								>
									{retrying ? (
										<Loader2Icon className="animate-spin" />
									) : (
										<RotateCcwIcon />
									)}
									{m.retry()}
								</Button>
							</div>
						)}
						{queued.map((row) =>
							row.subagentId ? (
								<NotificationLine
									key={`queued-${row.id}`}
									subagentId={row.subagentId}
									text={messageText(row.message)}
								/>
							) : (
								<Message key={`queued-${row.id}`} from="user">
									<MessageContent className="opacity-60">
										{messageText(row.message)}
									</MessageContent>
									<span className="text-xs text-muted-foreground">
										{m.queued()}
									</span>
								</Message>
							),
						)}
					</div>
				</div>
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
						onStop={() => void stopRun({ data: conversation.id })}
						onSend={async (input) => {
							await sendMessage({
								data: { ...input, conversationId: conversation.id },
							});
							await router.invalidate();
						}}
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
		</PanelContext>
	);
}

type Results = Map<string, ToolResultMessage>;

const toolResults = (messages: PiMessage[]): Results =>
	new Map(
		messages
			.filter((m): m is ToolResultMessage => m.role === "toolResult")
			.map((m) => [m.toolCallId, m]),
	);

/** One Subagent's process: a subagent row, or one kept in the Tool result's details by Runs from before the subagent table. */
type SubagentTranscript = {
	id?: string;
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

const collapsible =
	"group rounded-md border text-sm [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:items-center [&_summary]:gap-1.5 [&_summary]:px-3 [&_summary]:py-1.5 [&_summary]:text-muted-foreground";
const chevron = (
	<ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
);

/** A Tool call folded into one line (name and arguments); open it for the result. */
function ToolCallView({
	call,
	result,
}: {
	call: ToolCall;
	result?: ToolResultMessage;
}) {
	const { subagents } = Route.useLoaderData();
	const runs =
		(result?.details as { subagents?: SubagentTranscript[] } | undefined)
			?.subagents ?? subagents.filter((s) => s.toolCallId === call.id);
	if (call.name === "subagent" && runs.length)
		return runs.map((run, i) => (
			// biome-ignore lint/suspicious/noArrayIndexKey: saved runs never reorder
			<SubagentView key={i} run={run} />
		));
	return (
		<details className={collapsible}>
			<summary>
				{chevron}
				<span className="truncate">
					<span className="font-medium text-foreground">{call.name}</span>{" "}
					{Object.values(call.arguments).map(String).join(" · ")}
				</span>
				{!result && <Loader2Icon className="size-3.5 animate-spin" />}
			</summary>
			{result && (
				<pre
					className={`max-h-80 overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-xs ${result.isError ? "text-destructive" : ""}`}
				>
					{messageText(result)}
				</pre>
			)}
		</details>
	);
}

/** A Subagent as one line in its parent's reply, with what it is writing; open it for its own Conversation. */
function SubagentView({ run }: { run: SubagentTranscript }) {
	const { replies, open } = useContext(PanelContext);
	const name = useSubagentName(run);
	const running = run.outcome === "running";
	// a crashed Run never sends `end`: its reply stops showing with its outcome
	const live = running && run.id ? replies[run.id] : undefined;
	const preview = live?.at(-1)?.text.trim().split("\n").at(-1);
	return (
		<button
			type="button"
			onClick={() => open(run)}
			className="flex flex-col gap-0.5 rounded-md border px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/50"
		>
			<span className="flex w-full items-center gap-1.5">
				<span className="truncate">
					<span className="font-medium text-foreground">{name}</span>{" "}
					{run.brief}
				</span>
				{running ? (
					<Loader2Icon
						aria-label={m.generating()}
						className="ml-auto size-3.5 shrink-0 animate-spin"
					/>
				) : (
					<span
						className={`ml-auto shrink-0 text-xs ${run.outcome === "failed" ? "text-destructive" : ""}`}
					>
						{outcomeLabel(run.outcome)}
					</span>
				)}
				<ChevronRightIcon className="size-3.5 shrink-0" />
			</span>
			{preview && <span className="truncate text-xs">{preview}</span>}
		</button>
	);
}

/** A Subagent's Notification to its parent, as one system line: which one, and how it ended. */
function NotificationLine({
	subagentId,
	text,
}: {
	subagentId: string;
	text: string;
}) {
	const { subagents } = Route.useLoaderData();
	const { open } = useContext(PanelContext);
	const run = subagents.find((s) => s.id === subagentId);
	// how it ended this time: a continued Subagent notifies again
	const outcome = text.match(/^<task-notification [^>]*status="(\w+)"/)?.[1];
	if (!run) return null;
	return (
		<button
			type="button"
			onClick={() => open(run)}
			className="flex items-center gap-3 text-xs text-muted-foreground hover:text-foreground"
		>
			<Separator className="flex-1" />
			{m.subagent_number({ number: run.number })} · {outcomeLabel(outcome)}
			<Separator className="flex-1" />
		</button>
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
	const { replies } = useContext(PanelContext);
	const name = useSubagentName(run);
	const [stopping, setStopping] = useState(false);
	// focus lands on the title, not on Stop, so a stray Enter does not stop the Subagent
	const title = useRef<HTMLHeadingElement>(null);
	const id = run?.id;
	const loaded = useQuery({
		queryKey: ["subagent", id],
		queryFn: () => getSubagentMessages({ data: id as string }),
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
									await stopSubagent({ data: id });
									await router.invalidate();
								} finally {
									setStopping(false);
								}
							}}
						>
							{stopping ? (
								<Loader2Icon className="animate-spin" />
							) : (
								<SquareIcon />
							)}
							{m.stop_subagent()}
						</Button>
					)}
				</SheetHeader>
				<div className="flex flex-1 flex-col gap-6 overflow-y-auto px-4 pb-6">
					<Message from="user">
						<MessageContent className="whitespace-pre-wrap">
							{run?.brief}
						</MessageContent>
					</Message>
					{messages.map((message, i) =>
						message.role === "assistant" ? (
							// biome-ignore lint/suspicious/noArrayIndexKey: saved messages never reorder
							<AgentReply key={i} message={message} results={results} />
						) : message.role === "user" && i > 0 ? (
							// messages the parent sent while it worked; the first is the brief, shown above
							// biome-ignore lint/suspicious/noArrayIndexKey: saved messages never reorder
							<Message key={i} from="user">
								<MessageContent>{messageText(message)}</MessageContent>
							</Message>
						) : null,
					)}
					{live && <LiveReply parts={live} />}
					{(run?.outcome === "queued" ||
						(running && !live) ||
						(loaded.isFetching && !loaded.data)) && (
						<Loader2Icon
							aria-label={m.generating()}
							className="size-4 animate-spin text-muted-foreground"
						/>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

function AgentReply({
	message,
	results,
}: {
	message: AssistantMessage;
	results: Results;
}) {
	return (
		<Message from="assistant">
			<MessageContent className="flex flex-col gap-3">
				{message.content.map((part, i) =>
					part.type === "thinking" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: saved content never reorders
						<Reasoning key={i} text={part.thinking} />
					) : part.type === "text" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: saved content never reorders
						<MessageResponse key={i}>{part.text}</MessageResponse>
					) : (
						<ToolCallView
							key={part.id}
							call={part}
							result={results.get(part.id)}
						/>
					),
				)}
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
		<Message from="assistant">
			<MessageContent className="flex flex-col gap-3">
				{parts.map((part, i) =>
					part?.kind === "thinking" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: parts only grow
						<Reasoning key={i} text={part.text} isStreaming={i === last} />
					) : part ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: parts only grow
						<MessageResponse key={i} isAnimating mode="streaming">
							{part.text}
						</MessageResponse>
					) : null,
				)}
			</MessageContent>
		</Message>
	);
}
