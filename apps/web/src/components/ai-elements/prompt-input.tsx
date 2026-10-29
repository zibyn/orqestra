import { ArrowUpIcon, SquareIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

// Presentational composer, after shadcn AI Elements' PromptInput (no AI SDK)

export function PromptInput({ className, ...props }: ComponentProps<"form">) {
	return (
		<form
			className={cn(
				"flex flex-col rounded-xl border bg-background focus-within:border-ring",
				className,
			)}
			{...props}
		/>
	);
}

/** Enter submits the form; Shift+Enter adds a line. */
export function PromptInputTextarea({
	className,
	onKeyDown,
	...props
}: ComponentProps<typeof Textarea>) {
	return (
		<Textarea
			className={cn(
				"max-h-48 min-h-16 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent",
				className,
			)}
			onKeyDown={(e) => {
				onKeyDown?.(e);
				if (
					e.key === "Enter" &&
					!e.shiftKey &&
					!e.nativeEvent.isComposing &&
					!e.defaultPrevented
				) {
					e.preventDefault();
					e.currentTarget.form?.requestSubmit();
				}
			}}
			{...props}
		/>
	);
}

export function PromptInputFooter({
	className,
	...props
}: ComponentProps<"div">) {
	return (
		<div
			className={cn("flex items-center gap-1 p-2 pt-0", className)}
			{...props}
		/>
	);
}

/** Send button, or a stop button while a reply is generating. */
export function PromptInputSubmit({
	running,
	onStop,
	disabled,
}: {
	running: boolean;
	onStop: () => void;
	disabled?: boolean;
}) {
	return running ? (
		<Button
			type="button"
			size="icon-sm"
			aria-label={m.stop()}
			className="ml-auto"
			onClick={onStop}
		>
			<SquareIcon className="fill-current" />
		</Button>
	) : (
		<Button
			type="submit"
			size="icon-sm"
			aria-label={m.send()}
			className="ml-auto"
			disabled={disabled}
		>
			<ArrowUpIcon />
		</Button>
	);
}
