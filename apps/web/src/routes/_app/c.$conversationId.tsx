import type {
	AssistantMessage,
	Message as PiMessage,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { messageText } from "@orqestra/config/shared";
import type { ConversationEvent } from "@orqestra/db";
import {
	createFileRoute,
	getRouteApi,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import { ChevronRightIcon, Loader2Icon, RotateCcwIcon } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
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
	getConversation,
	retryRun,
	sendMessage,
	stopRun,
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

/**
 * The reply being generated, from the SSE stream; null when none is streaming to this tab.
 * Saved state reloads on (re)connect and on every `saved` event.
 */
function useLiveReply(conversationId: string) {
	const router = useRouter();
	const [live, setLive] = useState<Part[] | null>(null);
	useEffect(() => {
		const source = new EventSource(
			`/api/conversations/${conversationId}/events`,
		);
		// on (re)connect: load what is saved first, then follow the stream
		source.onopen = () => void router.invalidate();
		// counts replies started, so a reload finishing late keeps the reply that began meanwhile (Tool calls save mid-Run)
		let started = 0;
		source.onmessage = (e) => {
			const event = JSON.parse(e.data) as ConversationEvent;
			if (event.type === "start") {
				started++;
				setLive([]);
			} else if (event.type === "delta")
				// shortcut: a reply that began before we connected shows from the next delta on; replaying it needs a server-side buffer
				setLive((parts) => {
					const next = [...(parts ?? [])];
					const part = next[event.index] ?? { kind: event.kind, text: "" };
					next[event.index] = { ...part, text: part.text + event.delta };
					return next;
				});
			else {
				const at = started;
				void router.invalidate().then(() => at === started && setLive(null));
			}
		};
		return () => source.close();
	}, [conversationId, router]);
	return live;
}

function ConversationView() {
	const conversation = Route.useLoaderData();
	const { agents } = app.useLoaderData();
	const router = useRouter();
	const live = useLiveReply(conversation.id);
	const [retrying, setRetrying] = useState(false);
	const running = conversation.status === "running";
	const lastUser = conversation.messages
		.filter((row) => row.message.role === "user")
		.at(-1);
	const results = toolResults(conversation.messages.map((row) => row.message));

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
					{conversation.messages.map((row) => (
						<Fragment key={row.id}>
							{conversation.compactedBefore.includes(row.id) && (
								<div className="flex items-center gap-3 text-xs text-muted-foreground">
									<Separator className="flex-1" />
									{m.compacted_divider()}
									<Separator className="flex-1" />
								</div>
							)}
							{
								row.message.role === "user" ? (
									<Message from="user">
										<MessageContent>{messageText(row.message)}</MessageContent>
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
					agentId={conversation.agentId}
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
	template?: string | null;
	brief: string;
	messages: PiMessage[];
	status?: (typeof Route.types.loaderData)["subagents"][number]["status"];
};

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

/** A Subagent folded into one line (template and brief); open it for its process and result. */
function SubagentView({ run }: { run: SubagentTranscript }) {
	const { agents } = app.useLoaderData();
	const name = run.template
		? (agents.find((a) => a.id === run.template)?.name ?? run.template)
		: m.general_worker();
	const results = toolResults(run.messages);
	const status = (
		{
			queued: m.subagent_queued(),
			partial: m.subagent_partial(),
			failed: m.subagent_failed(),
			stopped: m.subagent_stopped(),
		} as Partial<Record<NonNullable<SubagentTranscript["status"]>, string>>
	)[run.status ?? "completed"];
	return (
		<details className={collapsible}>
			<summary>
				{chevron}
				<span className="truncate">
					<span className="font-medium text-foreground">{name}</span>{" "}
					{run.brief}
				</span>
				{status && (
					<span
						className={`ml-auto shrink-0 text-xs ${run.status === "failed" ? "text-destructive" : ""}`}
					>
						{status}
					</span>
				)}
				{run.status === "running" && (
					<Loader2Icon
						aria-label={m.generating()}
						className="ml-auto size-3.5 shrink-0 animate-spin"
					/>
				)}
			</summary>
			<div className="flex flex-col gap-3 border-t px-3 py-2">
				<p className="whitespace-pre-wrap text-muted-foreground">{run.brief}</p>
				{run.messages.map((message, i) =>
					message.role === "assistant" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: saved messages never reorder
						<AgentReply key={i} message={message} results={results} />
					) : null,
				)}
			</div>
		</details>
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
