import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/lib/auth-client";
import { getLoginOptions } from "#/lib/instance";

const errors: Record<string, string> = {
	account_not_linked:
		"A user with this email already exists, but Polaris has not verified the email, so they cannot be merged.",
};

export const Route = createFileRoute("/login")({
	validateSearch: z.object({ error: z.string().optional() }),
	beforeLoad: ({ context }) => {
		if (context.user) throw redirect({ to: "/" });
	},
	loader: () => getLoginOptions(),
	component: Login,
});

function Login() {
	const { oidcConfigured, memberPassword } = Route.useLoaderData();
	const search = Route.useSearch();
	// Admins can always use a password, even when the form is hidden for Members
	const [showPassword, setShowPassword] = useState(memberPassword);
	const [error, setError] = useState(
		search.error ? (errors[search.error] ?? search.error) : "",
	);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const { error } = await authClient.signIn.email({
			email: String(form.get("email")),
			password: String(form.get("password")),
		});
		if (error) setError(error.message ?? "Sign-in failed");
		else window.location.href = "/";
	}

	return (
		<main className="mx-auto flex max-w-sm flex-col gap-6 p-8">
			<h1 className="text-2xl font-semibold">Sign in</h1>
			{oidcConfigured && (
				<Button
					onClick={() =>
						authClient.signIn.social({
							provider: "polaris",
							callbackURL: "/",
							errorCallbackURL: "/login",
						})
					}
				>
					Sign in with Polaris
				</Button>
			)}
			{showPassword ? (
				<form onSubmit={onSubmit} className="flex flex-col gap-4">
					<Label htmlFor="email">Email</Label>
					<Input id="email" name="email" type="email" required />
					<Label htmlFor="password">Password</Label>
					<Input id="password" name="password" type="password" required />
					<Button
						type="submit"
						variant={oidcConfigured ? "outline" : "default"}
					>
						Sign in with password
					</Button>
				</form>
			) : (
				<Button variant="link" onClick={() => setShowPassword(true)}>
					Admin sign-in with password
				</Button>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
		</main>
	);
}
