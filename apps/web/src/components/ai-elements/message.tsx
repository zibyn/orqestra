import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { cn } from "#/lib/utils";

const plugins = { cjk, code, math, mermaid };

/** Streaming-safe Markdown for Agent replies, styled as AI Elements ships it; the turn around it is `ui/message`. */
export function MessageResponse({
	className,
	...props
}: ComponentProps<typeof Streamdown>) {
	return (
		<Streamdown
			className={cn(
				"size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
				className,
			)}
			plugins={plugins}
			// copy only: a download button is clutter on a chat snippet
			controls={{ code: { download: false } }}
			{...props}
		/>
	);
}
