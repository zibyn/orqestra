import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { getSettings, saveAllowMemberPassword } from "#/lib/instance";

export const Route = createFileRoute("/console/settings")({
	loader: () => getSettings(),
	component: Settings,
});

function Settings() {
	const { allowMemberPassword, oidc } = Route.useLoaderData();
	const router = useRouter();

	return (
		<section className="flex flex-col gap-6">
			<h1 className="text-2xl font-semibold">Settings</h1>
			<div className="flex items-center gap-3">
				<Switch
					id="allow-member-password"
					checked={allowMemberPassword}
					onCheckedChange={async (checked) => {
						await saveAllowMemberPassword({ data: checked });
						await router.invalidate();
					}}
				/>
				<Label htmlFor="allow-member-password">
					Allow Members to sign in with a password
				</Label>
			</div>
			{!oidc.configured && (
				<p className="text-sm text-muted-foreground">
					No Identity Provider is configured, so everyone can sign in with a
					password.
				</p>
			)}
			<div className="text-sm">
				<h2 className="mb-1 font-medium">Identity Provider (OIDC)</h2>
				{oidc.configured ? (
					<p>
						Configured — issuer <code>{oidc.issuer}</code>
					</p>
				) : (
					<p>
						Not configured. Set OIDC_ISSUER, OIDC_CLIENT_ID and
						OIDC_CLIENT_SECRET.
					</p>
				)}
			</div>
		</section>
	);
}
