import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
} from "@tanstack/react-router";
import { isAdmin } from "#/lib/identity";

export const Route = createFileRoute("/console")({
	beforeLoad: ({ context }) => {
		if (!context.user) throw redirect({ to: "/login" });
		if (!isAdmin(context.user)) throw redirect({ to: "/" });
	},
	component: Console,
});

function Console() {
	return (
		<main className="flex flex-col gap-6 p-8">
			<nav className="flex gap-4 text-sm">
				<Link to="/" className="text-muted-foreground">
					Home
				</Link>
				<Link
					to="/console"
					activeOptions={{ exact: true }}
					activeProps={{ className: "font-semibold" }}
				>
					Users
				</Link>
				<Link
					to="/console/settings"
					activeProps={{ className: "font-semibold" }}
				>
					Settings
				</Link>
			</nav>
			<Outlet />
		</main>
	);
}
