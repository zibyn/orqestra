import { Collapsible } from "@base-ui/react/collapsible";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

// Collapsible "thinking" block, after shadcn AI Elements' Reasoning: open while streaming, closes once done

export function Reasoning({
	text,
	isStreaming = false,
}: {
	text: string;
	isStreaming?: boolean;
}) {
	const [open, setOpen] = useState(isStreaming);
	useEffect(() => {
		setOpen(isStreaming);
	}, [isStreaming]);

	return (
		<Collapsible.Root
			open={open}
			onOpenChange={setOpen}
			className="w-full text-sm"
		>
			<Collapsible.Trigger className="flex items-center gap-1.5 rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
				<BrainIcon className="size-4" />
				{isStreaming ? m.thinking_live() : m.thinking_done()}
				<ChevronDownIcon
					className={cn("size-4 transition-transform", open && "rotate-180")}
				/>
			</Collapsible.Trigger>
			<Collapsible.Panel className="mt-2 border-l-2 pl-3 whitespace-pre-wrap text-muted-foreground">
				{text}
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}
