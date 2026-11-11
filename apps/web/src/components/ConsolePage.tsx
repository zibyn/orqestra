import { Loader2Icon, type LucideIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Sheet,
	SheetClose,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "#/components/ui/sheet";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

/** A /console page: title, one line of description, an optional primary action, then the content. */
export function ConsolePage({
	title,
	description,
	action,
	children,
}: {
	title: string;
	description: string;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
			<header className="flex flex-wrap items-end justify-between gap-4">
				<div className="flex flex-col gap-1">
					<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
					<p className="text-sm text-muted-foreground">{description}</p>
				</div>
				{action && <div className="flex gap-2">{action}</div>}
			</header>
			{children}
		</div>
	);
}

/** The items of a /console page as rows in one bordered list, or an empty state. */
export function ItemList({
	empty,
	children,
}: {
	empty?: { icon: LucideIcon; title: string; hint: string };
	children: ReactNode[];
}) {
	if (!children.length && empty)
		return (
			<div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-center">
				<empty.icon className="size-8 text-muted-foreground" />
				<p className="text-lg font-medium">{empty.title}</p>
				<p className="max-w-md text-sm text-muted-foreground">{empty.hint}</p>
			</div>
		);
	return <ul className="divide-y rounded-xl border">{children}</ul>;
}

/** One row of an `ItemList`: name and badges, a muted line, actions on the right, and anything else (warnings) below. */
export function Item({
	title,
	description,
	actions,
	children,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<div className="flex flex-wrap items-center gap-2 font-medium">
						{title}
					</div>
					{description && (
						<div className="truncate text-sm text-muted-foreground">
							{description}
						</div>
					)}
				</div>
				{actions && (
					<div className="flex shrink-0 items-center gap-2">{actions}</div>
				)}
			</div>
			{children}
		</li>
	);
}

/** The delete action of an `Item`: an icon button, its confirm left to the caller. */
export function DeleteButton({
	busy,
	disabled,
	onClick,
}: {
	busy: boolean;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Button
			size="icon-sm"
			variant="ghost"
			className="text-muted-foreground hover:text-destructive"
			aria-label={m.delete()}
			disabled={disabled || busy}
			onClick={onClick}
		>
			{busy ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
		</Button>
	);
}

/** Which item a `FormSheet` shows, open on `initial` if given; the item outlives `open` so the sheet keeps its content while it slides out. */
export function useSheet<T>(initial?: T) {
	const [state, setState] = useState<{ open: boolean; item?: T }>({
		open: initial !== undefined,
		item: initial,
	});
	return {
		...state,
		show: (item: T) => setState({ open: true, item }),
		close: () => setState((s) => ({ ...s, open: false })),
	};
}

/** A drawer from the right that holds an add or edit form; its content unmounts once closed, so reopening starts fresh. */
export function FormSheet({
	open,
	onClose,
	title,
	description,
	className,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	description?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	return (
		<Sheet open={open} onOpenChange={(o) => !o && onClose()}>
			{/* width classes need the `data-[side=right]:` prefix to beat the Sheet's own `max-w-sm` */}
			<SheetContent
				className={cn("w-full gap-0 data-[side=right]:sm:max-w-lg", className)}
			>
				<SheetHeader className="border-b pr-12">
					<SheetTitle className="flex flex-wrap items-center gap-2 text-base">
						{title}
					</SheetTitle>
					{description && <SheetDescription>{description}</SheetDescription>}
				</SheetHeader>
				{children}
			</SheetContent>
		</Sheet>
	);
}

/**
 * The body of a `FormSheet`: scrolling fields, then submit, `extra` actions and cancel pinned at the bottom.
 * `after` scrolls below the fields outside the form, so forms of its own neither nest in it nor submit it.
 */
export function SheetForm({
	onSubmit,
	busy,
	submitLabel,
	extra,
	after,
	children,
}: {
	onSubmit: () => void;
	busy: boolean;
	submitLabel: string;
	extra?: ReactNode;
	after?: ReactNode;
	children: ReactNode;
}) {
	const id = useId();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* a container, so the fields lay out by the sheet's width, not the screen's */}
			<div className="@container flex flex-1 flex-col gap-5 overflow-y-auto p-4">
				<form
					id={id}
					onSubmit={(e: FormEvent) => {
						e.preventDefault();
						onSubmit();
					}}
				>
					{children}
				</form>
				{after}
			</div>
			<SheetFooter className="flex-row flex-wrap border-t">
				<Button type="submit" form={id} disabled={busy}>
					{busy && (
						<Loader2Icon data-icon="inline-start" className="animate-spin" />
					)}
					{submitLabel}
				</Button>
				{extra}
				<SheetClose render={<Button type="button" variant="ghost" />}>
					{m.cancel()}
				</SheetClose>
			</SheetFooter>
		</div>
	);
}
