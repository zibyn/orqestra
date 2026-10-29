import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { runSetup } from "#/lib/instance";
import { m } from "#/paraglide/messages";

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
		<main className="flex min-h-svh items-center justify-center p-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="text-xl">{m.setup_title()}</CardTitle>
					<CardDescription>{m.setup_subtitle()}</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={onSubmit} className="flex flex-col gap-4">
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
						{error && <p className="text-sm text-destructive">{error}</p>}
						<Button type="submit" className="w-full">
							{m.setup_submit()}
						</Button>
					</form>
				</CardContent>
			</Card>
		</main>
	);
}
