import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { signOut } from "#/lib/auth-client";
import { displayName, isAdmin } from "#/lib/identity";

export const Route = createFileRoute("/")({
	beforeLoad: ({ context }) => {
		if (!context.user) throw redirect({ to: "/login" });
		return { user: context.user };
	},
	component: Home,
});

function Home() {
	const { user } = Route.useRouteContext();
	return (
		<main className="flex flex-col gap-4 p-8">
			<p>Signed in as {displayName(user)}</p>
			<div className="flex gap-2">
				{isAdmin(user) && (
					<Button variant="outline" render={<Link to="/console" />}>
						Console
					</Button>
				)}
				<Button variant="outline" onClick={signOut}>
					Sign out
				</Button>
			</div>
		</main>
	);
}
