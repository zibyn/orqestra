import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpIcon, MessageSquareIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Textarea } from "#/components/ui/textarea";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/_app/")({ component: NewConversation });

// shortcut: shell only (empty state + inert composer), sending lands in #4
function NewConversation() {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
				<MessageSquareIcon className="size-8 text-muted-foreground" />
				<h1 className="text-lg font-medium">{m.empty_title()}</h1>
				<p className="text-sm text-muted-foreground">{m.empty_hint()}</p>
			</div>
			<form
				className="mx-auto w-full max-w-3xl px-4 pb-4"
				onSubmit={(e) => e.preventDefault()}
			>
				<div className="relative rounded-xl border bg-background focus-within:border-ring">
					<Textarea
						aria-label={m.composer_placeholder()}
						placeholder={m.composer_placeholder()}
						className="max-h-48 min-h-20 resize-none border-0 bg-transparent pr-12 shadow-none focus-visible:ring-0 dark:bg-transparent"
					/>
					<Button
						type="submit"
						size="icon-sm"
						disabled
						aria-label={m.send()}
						className="absolute right-2 bottom-2"
					>
						<ArrowUpIcon />
					</Button>
				</div>
			</form>
		</div>
	);
}
