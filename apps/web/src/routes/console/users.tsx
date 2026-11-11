import { createFileRoute } from "@tanstack/react-router";
import { ConsolePage } from "#/components/ConsolePage";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { api, ok } from "#/lib/api";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export const Route = createFileRoute("/console/users")({
	loader: async () => (await ok(api().api.users.get())).users,
	component: UsersPage,
});

/** The Users who have used Orqestra; the Admin viewing is one of them, so the list is never empty. */
function UsersPage() {
	const users = Route.useLoaderData();
	return (
		<ConsolePage title={m.users()} description={m.users_hint()}>
			<div className="rounded-xl border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{m.user_name()}</TableHead>
							<TableHead>{m.user_email()}</TableHead>
							<TableHead>{m.user_last_active()}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{users.map((u) => (
							<TableRow key={u.id}>
								<TableCell className="font-medium">{u.name}</TableCell>
								<TableCell className="text-muted-foreground">
									{u.email ?? "—"}
								</TableCell>
								<TableCell>
									{new Date(u.lastActiveAt).toLocaleString(getLocale())}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</ConsolePage>
	);
}
