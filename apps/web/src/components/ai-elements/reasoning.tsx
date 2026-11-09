import { BrainIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import {
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "#/components/ui/trace";
import { m } from "#/paraglide/messages";

// shadcn AI Elements' Reasoning, a Trace row: open while streaming, closes once done unless the User toggled it

export function Reasoning({
	text,
	isStreaming = false,
}: {
	text: string;
	isStreaming?: boolean;
}) {
	const [open, setOpen] = useState<boolean>();
	const line = (
		<TraceLine status={isStreaming ? "running" : undefined}>
			<TraceIcon>
				{isStreaming ? (
					<Loader2Icon className="animate-spin text-signal" />
				) : (
					<BrainIcon />
				)}
			</TraceIcon>
			<TraceTitle>
				{isStreaming ? m.thinking_live() : m.thinking_done()}
			</TraceTitle>
		</TraceLine>
	);
	if (!text) return line;
	return (
		<TraceCollapsible open={open ?? isStreaming} onOpenChange={setOpen}>
			<TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
			<TraceCollapsibleContent className="whitespace-pre-wrap">
				{text}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}
