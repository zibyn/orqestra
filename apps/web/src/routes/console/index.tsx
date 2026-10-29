import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { authClient } from "#/lib/auth-client";
import { displayName, isAdmin } from "#/lib/identity";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/")({ component: Users });

function Users() {
	const [error, setError] = useState("");
	// which action is in flight: "create", or `${userId}:role` / `${userId}:ban`
	const [busy, setBusy] = useState<string>();
	const users = useQuery({
		queryKey: ["users"],
		queryFn: async () => {
			const { data, error } = await authClient.admin.listUsers({
				query: { limit: 1000, sortBy: "createdAt" },
			});
			if (error) throw new Error(error.message);
			return data.users;
		},
	});

	async function applyAndRefetch(
		key: string,
		action: () => Promise<{ error: { message?: string } | null }>,
	) {
		setBusy(key);
		try {
			const { error } = await action();
			setError(error ? (error.message ?? m.request_failed()) : "");
			await users.refetch();
		} finally {
			setBusy(undefined);
		}
	}
	const spinner = (key: string) =>
		busy === key && <Loader2Icon className="animate-spin" />;

	async function onCreate(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = e.currentTarget;
		const data = new FormData(form);
		const email = String(data.get("email"));
		await applyAndRefetch("create", () =>
			authClient.admin.createUser({
				email,
				password: String(data.get("password")),
				name: email,
				role: "user",
			}),
		);
		form.reset();
	}

	return (
		<section className="flex flex-col gap-6">
			<h1 className="text-xl font-semibold">{m.console_users()}</h1>
			<form onSubmit={onCreate} className="flex flex-wrap items-end gap-2">
				<div className="flex flex-col gap-2">
					<Label htmlFor="email">{m.email()}</Label>
					<Input id="email" name="email" type="email" required />
				</div>
				<div className="flex flex-col gap-2">
					<Label htmlFor="password">{m.password()}</Label>
					<Input
						id="password"
						name="password"
						type="password"
						minLength={8}
						required
					/>
				</div>
				<Button type="submit" disabled={busy === "create"}>
					{spinner("create")}
					{m.add_member()}
				</Button>
			</form>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="px-3">{m.user()}</TableHead>
							<TableHead>{m.role()}</TableHead>
							<TableHead>{m.status()}</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{users.data?.map((u) => (
							<TableRow key={u.id}>
								<TableCell className="px-3">{displayName(u)}</TableCell>
								<TableCell>
									{isAdmin(u) ? m.role_admin() : m.role_member()}
								</TableCell>
								<TableCell className={u.banned ? "text-destructive" : ""}>
									{u.banned ? m.status_banned() : m.status_active()}
								</TableCell>
								<TableCell>
									<div className="flex justify-end gap-2 pr-1">
										<Button
											size="sm"
											variant="outline"
											disabled={busy === `${u.id}:role`}
											onClick={() =>
												applyAndRefetch(`${u.id}:role`, () =>
													authClient.admin.setRole({
														userId: u.id,
														role: isAdmin(u) ? "user" : "admin",
													}),
												)
											}
										>
											{spinner(`${u.id}:role`)}
											{isAdmin(u) ? m.make_member() : m.make_admin()}
										</Button>
										<Button
											size="sm"
											variant={u.banned ? "outline" : "destructive"}
											disabled={busy === `${u.id}:ban`}
											onClick={() =>
												applyAndRefetch(`${u.id}:ban`, () =>
													u.banned
														? authClient.admin.unbanUser({ userId: u.id })
														: authClient.admin.banUser({ userId: u.id }),
												)
											}
										>
											{spinner(`${u.id}:ban`)}
											{u.banned ? m.unban() : m.ban()}
										</Button>
									</div>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</section>
	);
}
