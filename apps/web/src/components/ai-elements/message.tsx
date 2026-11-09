import { code } from "@streamdown/code";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { cn } from "#/lib/utils";

/** Streaming-safe Markdown for Agent replies; the turn around it is `ui/message`. */
export function MessageResponse({
	className,
	...props
}: ComponentProps<typeof Streamdown>) {
	return (
		<Streamdown
			className={cn(
				// prose quotes inline code with backticks; Streamdown already styles it as code
				"prose prose-neutral dark:prose-invert max-w-none prose-code:before:content-none prose-code:after:content-none",
				className,
			)}
			plugins={{ code }}
			// copy only: a download button is clutter on a chat snippet
			controls={{ code: { download: false } }}
			{...props}
		/>
	);
}
