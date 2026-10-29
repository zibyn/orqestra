import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { runSetup } from "#/lib/instance";

export const Route = createFileRoute("/setup")({ component: Setup });

function Setup() {
	const navigate = useNavigate();
	const [error, setError] = useState("");

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		try {
			await runSetup({
				data: {
					email: String(form.get("email")),
					password: String(form.get("password")),
				},
			});
			await navigate({ to: "/login" });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<main className="mx-auto max-w-sm p-8">
			<h1 className="mb-2 text-2xl font-semibold">Set up Orqestra</h1>
			<p className="mb-6 text-sm text-muted-foreground">
				Create the Default Admin account.
			</p>
			<form onSubmit={onSubmit} className="flex flex-col gap-4">
				<Label htmlFor="email">Email</Label>
				<Input id="email" name="email" type="email" required />
				<Label htmlFor="password">Password</Label>
				<Input
					id="password"
					name="password"
					type="password"
					minLength={8}
					required
				/>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<Button type="submit">Create admin</Button>
			</form>
		</main>
	);
}
