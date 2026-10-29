import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { getSettings, saveAllowMemberPassword } from "#/lib/instance";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/settings")({
	loader: () => getSettings(),
	component: Settings,
});

function Settings() {
	const { allowMemberPassword, oidc } = Route.useLoaderData();
	const router = useRouter();

	return (
		<section className="flex flex-col gap-6">
			<h1 className="text-xl font-semibold">{m.console_settings()}</h1>
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
					{m.allow_member_password()}
				</Label>
			</div>
			{!oidc.configured && (
				<p className="text-sm text-muted-foreground">{m.no_idp_hint()}</p>
			)}
			<div className="rounded-lg border p-4 text-sm">
				<h2 className="mb-1 font-medium">{m.idp_title()}</h2>
				{oidc.configured ? (
					<p>
						{m.idp_configured()}
						<code className="rounded bg-muted px-1 py-0.5 font-mono">
							{oidc.issuer}
						</code>
					</p>
				) : (
					<p>{m.idp_not_configured()}</p>
				)}
			</div>
		</section>
	);
}
