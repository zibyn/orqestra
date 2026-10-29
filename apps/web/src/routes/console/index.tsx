import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { displayName, isAdmin } from "#/lib/identity";

export const Route = createFileRoute("/console/")({ component: Users });

function Users() {
	const [error, setError] = useState("");
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
		action: Promise<{ error: { message?: string } | null }>,
	) {
		const { error } = await action;
		setError(error ? (error.message ?? "Request failed") : "");
		await users.refetch();
	}

	async function onCreate(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = e.currentTarget;
		const data = new FormData(form);
		const email = String(data.get("email"));
		await applyAndRefetch(
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
			<h1 className="text-2xl font-semibold">Users</h1>
			<form onSubmit={onCreate} className="flex flex-wrap items-end gap-2">
				<div className="flex flex-col gap-1">
					<Label htmlFor="email">Email</Label>
					<Input id="email" name="email" type="email" required />
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="password">Password</Label>
					<Input
						id="password"
						name="password"
						type="password"
						minLength={8}
						required
					/>
				</div>
				<Button type="submit">Add Member</Button>
			</form>
			{error && <p className="text-sm text-destructive">{error}</p>}
			<table className="w-full text-left text-sm">
				<thead>
					<tr>
						<th className="py-2">User</th>
						<th>Role</th>
						<th>Status</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{users.data?.map((u) => (
						<tr key={u.id} className="border-t">
							<td className="py-2">{displayName(u)}</td>
							<td>{isAdmin(u) ? "Admin" : "Member"}</td>
							<td>{u.banned ? "Banned" : "Active"}</td>
							<td className="flex justify-end gap-2 py-2">
								<Button
									size="sm"
									variant="outline"
									onClick={() =>
										applyAndRefetch(
											authClient.admin.setRole({
												userId: u.id,
												role: isAdmin(u) ? "user" : "admin",
											}),
										)
									}
								>
									{isAdmin(u) ? "Make Member" : "Make Admin"}
								</Button>
								<Button
									size="sm"
									variant={u.banned ? "outline" : "destructive"}
									onClick={() =>
										applyAndRefetch(
											u.banned
												? authClient.admin.unbanUser({ userId: u.id })
												: authClient.admin.banUser({ userId: u.id }),
										)
									}
								>
									{u.banned ? "Unban" : "Ban"}
								</Button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</section>
	);
}
