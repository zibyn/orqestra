import {
	ArrowUpIcon,
	ChevronDownIcon,
	Loader2Icon,
	SquareIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "#/components/ui/input-group";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

// Presentational composer: shadcn AI Elements' Prompt Input, an InputGroup in a form (no AI SDK)

export function PromptInput({
	className,
	children,
	...props
}: ComponentProps<"form">) {
	return (
		<form className={className} {...props}>
			<InputGroup className="h-auto flex-col items-stretch rounded-xl bg-background">
				{children}
			</InputGroup>
		</form>
	);
}

/** Above the text: attachments, or the Skills that match what is typed. */
export function PromptInputHeader({
	className,
	...props
}: ComponentProps<typeof InputGroupAddon>) {
	return (
		<InputGroupAddon
			align="block-start"
			className={cn("flex-wrap", className)}
			{...props}
		/>
	);
}

/** Enter submits the form; Shift+Enter adds a line. */
export function PromptInputTextarea({
	className,
	onKeyDown,
	...props
}: ComponentProps<typeof InputGroupTextarea>) {
	return (
		<InputGroupTextarea
			className={cn("max-h-48 min-h-16 p-3", className)}
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
}: ComponentProps<typeof InputGroupAddon>) {
	return (
		<InputGroupAddon
			align="block-end"
			className={cn("gap-1", className)}
			{...props}
		/>
	);
}

/** One pick for the message (Agent, Model, thinking), after shadcn AI Elements' Model Selector. */
export function PromptInputMenu({
	label,
	value,
	onChange,
	items,
	showLabel,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	items: { value: string; label: string }[];
	/** Name the pick on the button too, where its value alone says little ("低"). */
	showLabel?: boolean;
}) {
	const current = items.find((i) => i.value === value)?.label ?? value;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<InputGroupButton
						size="sm"
						variant="ghost"
						aria-label={`${label}: ${current}`}
					/>
				}
			>
				{showLabel && <span className="text-muted-foreground">{label}</span>}
				<span className="max-w-40 truncate">{current}</span>
				<ChevronDownIcon />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" side="top" className="w-auto min-w-40">
				<DropdownMenuGroup>
					<DropdownMenuLabel>{label}</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={value}
						onValueChange={(v) => v && onChange(v)}
					>
						{items.map((item) => (
							<DropdownMenuRadioItem
								key={item.value}
								value={item.value}
								closeOnClick
							>
								{item.label}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Send button, with a stop button beside it while a reply is generating. */
export function PromptInputSubmit({
	running,
	onStop,
	disabled,
	busy,
}: {
	running: boolean;
	onStop: () => void;
	disabled?: boolean;
	/** The message is being sent. */
	busy?: boolean;
}) {
	return (
		<>
			{running && (
				<InputGroupButton
					size="icon-sm"
					variant="outline"
					aria-label={m.stop()}
					className="rounded-full"
					onClick={onStop}
				>
					<SquareIcon className="fill-current" />
				</InputGroupButton>
			)}
			<InputGroupButton
				type="submit"
				size="icon-sm"
				variant="default"
				aria-label={m.send()}
				className="rounded-full"
				disabled={disabled || busy}
			>
				{busy ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
			</InputGroupButton>
		</>
	);
}
