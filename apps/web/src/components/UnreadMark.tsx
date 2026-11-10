import { CircleHelpIcon } from "lucide-react";
import { m } from "#/paraglide/messages";

/** A Conversation's mark at rest, at the end of its row: the Question it waits on, else a dot while Unread, else nothing. */
export function UnreadMark({
	unread,
	awaitingReply,
}: {
	unread: boolean;
	awaitingReply: boolean;
}) {
	if (awaitingReply)
		return (
			<CircleHelpIcon
				role="img"
				aria-label={m.awaiting_reply()}
				className="ml-auto size-4 shrink-0 text-foreground"
			/>
		);
	return (
		unread && (
			<span
				role="img"
				aria-label={m.unread()}
				className="ml-auto size-2 shrink-0 rounded-full bg-foreground"
			/>
		)
	);
}
