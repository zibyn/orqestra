import type { AssistantMessage } from "@earendil-works/pi-ai";
import { messageText } from "@orqestra/config/shared";
import type { ConversationEvent } from "@orqestra/db";
import {
	createFileRoute,
	getRouteApi,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import { Loader2Icon, RotateCcwIcon } from "lucide-react";
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
		source.onmessage = (e) => {
			const event = JSON.parse(e.data) as ConversationEvent;
			if (event.type === "start") setLive([]);
			else if (event.type === "delta")
				// shortcut: a reply that began before we connected shows from the next delta on; replaying it needs a server-side buffer
				setLive((parts) => {
					const next = [...(parts ?? [])];
					const part = next[event.index] ?? { kind: event.kind, text: "" };
					next[event.index] = { ...part, text: part.text + event.delta };
					return next;
				});
			else void router.invalidate().then(() => setLive(null));
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
							{row.message.role === "user" ? (
								<Message from="user">
									<MessageContent>{messageText(row.message)}</MessageContent>
								</Message>
							) : (
								<AgentReply message={row.message as AssistantMessage} />
							)}
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

function AgentReply({ message }: { message: AssistantMessage }) {
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
					) : null,
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
