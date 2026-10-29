import { code } from "@streamdown/code";
import type { ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { cn } from "#/lib/utils";

// Presentational chat message, after shadcn AI Elements' Message (no AI SDK)

export function Message({
	from,
	className,
	...props
}: ComponentProps<"div"> & { from: "user" | "assistant" }) {
	return (
		<div
			data-from={from}
			className={cn(
				"group flex w-full flex-col gap-2",
				from === "user" ? "items-end" : "items-start",
				className,
			)}
			{...props}
		/>
	);
}

export function MessageContent({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"min-w-0",
				"group-data-[from=user]:max-w-[80%] group-data-[from=user]:rounded-2xl group-data-[from=user]:bg-muted group-data-[from=user]:px-4 group-data-[from=user]:py-2.5 group-data-[from=user]:whitespace-pre-wrap",
				"group-data-[from=assistant]:w-full",
				className,
			)}
			{...props}
		/>
	);
}

/** Streaming-safe Markdown for Agent replies. */
export function MessageResponse({
	className,
	...props
}: ComponentProps<typeof Streamdown>) {
	return (
		<Streamdown
			className={cn(
				"prose prose-neutral dark:prose-invert max-w-none",
				className,
			)}
			plugins={{ code }}
			// copy only: a download button is clutter on a chat snippet
			controls={{ code: { download: false } }}
			{...props}
		/>
	);
}
