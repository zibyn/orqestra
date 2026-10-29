import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { isAdmin } from "#/lib/identity";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console")({
	beforeLoad: ({ context }) => {
		if (!context.user) throw redirect({ to: "/login" });
		if (!isAdmin(context.user)) throw redirect({ to: "/" });
	},
	component: Console,
});

const tabClass =
	"-mb-px border-b-2 border-transparent px-1 pb-2 text-muted-foreground transition-colors hover:text-foreground data-[status=active]:border-foreground data-[status=active]:text-foreground";

function Console() {
	return (
		<main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
			<header className="flex flex-col gap-4 border-b">
				<div className="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={m.back_to_app()}
						nativeButton={false}
						render={<Link to="/" />}
					>
						<ArrowLeftIcon />
					</Button>
					<span className="text-lg font-semibold">{m.console()}</span>
				</div>
				<nav className="flex gap-4 text-sm">
					<Link
						to="/console"
						className={tabClass}
						activeOptions={{ exact: true }}
					>
						{m.console_users()}
					</Link>
					<Link to="/console/settings" className={tabClass}>
						{m.console_settings()}
					</Link>
					<Link to="/console/agents" className={tabClass}>
						{m.console_agents()}
					</Link>
				</nav>
			</header>
			<Outlet />
		</main>
	);
}
