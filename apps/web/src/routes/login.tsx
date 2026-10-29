import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
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
import { authClient } from "#/lib/auth-client";
import { getLoginOptions } from "#/lib/instance";
import { m } from "#/paraglide/messages";

const errors: Record<string, () => string> = {
	account_not_linked: m.error_account_not_linked,
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
		search.error ? (errors[search.error]?.() ?? search.error) : "",
	);

	async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault();
		const form = new FormData(e.currentTarget);
		const { error } = await authClient.signIn.email({
			email: String(form.get("email")),
			password: String(form.get("password")),
		});
		if (error) setError(error.message ?? m.sign_in_failed());
		else window.location.href = "/";
	}

	return (
		<main className="flex min-h-svh items-center justify-center p-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle className="text-xl">{m.sign_in()}</CardTitle>
					<CardDescription>{m.sign_in_subtitle()}</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{oidcConfigured && (
						<Button
							className="w-full"
							onClick={() =>
								authClient.signIn.social({
									provider: "polaris",
									callbackURL: "/",
									errorCallbackURL: "/login",
								})
							}
						>
							{m.sign_in_polaris()}
						</Button>
					)}
					{showPassword ? (
						<form onSubmit={onSubmit} className="flex flex-col gap-4">
							<div className="flex flex-col gap-2">
								<Label htmlFor="email">{m.email()}</Label>
								<Input id="email" name="email" type="email" required />
							</div>
							<div className="flex flex-col gap-2">
								<Label htmlFor="password">{m.password()}</Label>
								<Input id="password" name="password" type="password" required />
							</div>
							<Button
								type="submit"
								className="w-full"
								variant={oidcConfigured ? "outline" : "default"}
							>
								{m.sign_in_password()}
							</Button>
						</form>
					) : (
						<Button variant="link" onClick={() => setShowPassword(true)}>
							{m.admin_password_sign_in()}
						</Button>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</CardContent>
			</Card>
		</main>
	);
}
