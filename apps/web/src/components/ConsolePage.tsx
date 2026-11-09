import type { ReactNode } from "react";

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
				{action}
			</header>
			{children}
		</div>
	);
}
