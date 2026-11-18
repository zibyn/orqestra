import { createFileRoute } from "@tanstack/react-router";
import {
	CheckCircle2Icon,
	CopyIcon,
	Loader2Icon,
	TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { api, ok } from "#/lib/api";
import { errorText, saved, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/linear")({
	// where the api's callback sends the Admin back from Linear
	validateSearch: (search): { error?: string } =>
		typeof search.error === "string" ? { error: search.error } : {},
	loader: () => ok(api().api.linear.get()),
	component: Linear,
});

const callbackErrors: Record<string, () => string> = {
	state_invalid: m.linear_state_invalid,
	denied: m.linear_denied,
	failed: m.linear_failed,
};

/** Orqestra's Linear app: its credentials, write-only secrets, and the workspace it is installed in. */
function Linear() {
	const { installation, callbackUrl } = Route.useLoaderData();
	const search = Route.useSearch();
	const [clientId, setClientId] = useState(installation?.clientId ?? "");
	const [clientSecret, setClientSecret] = useState("");
	const [webhookSecret, setWebhookSecret] = useState("");
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const workspace = installation?.workspace;

	async function install() {
		setBusy(true);
		try {
			const result = await saved(
				api().api.linear.post({ clientId, clientSecret, webhookSecret }),
			);
			setErrors(saveErrorTexts(result.errors));
			// on to Linear's authorization page, which sends the Admin back here
			if (result.url) return location.assign(result.url);
		} catch (e) {
			setErrors({ "": errorText(e) });
		}
		setBusy(false);
	}

	return (
		<ConsolePage title={m.linear()} description={m.linear_hint()}>
			<Card>
				<CardContent className="flex flex-col gap-5">
					{workspace && (
						<Alert>
							<CheckCircle2Icon />
							<AlertDescription>
								{m.linear_connected({ workspace })}
							</AlertDescription>
						</Alert>
					)}
					{search.error && (
						<Alert variant="destructive">
							<TriangleAlertIcon />
							<AlertDescription>
								{(callbackErrors[search.error] ?? m.linear_failed)()}
							</AlertDescription>
						</Alert>
					)}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void install();
						}}
					>
						<FieldGroup className="gap-5">
							<Field>
								<FieldLabel htmlFor="linear-callback">
									{m.mcp_oauth_callback()}
								</FieldLabel>
								<div className="flex gap-2">
									<Input
										id="linear-callback"
										readOnly
										className="font-mono"
										value={callbackUrl}
									/>
									<Button
										type="button"
										size="icon"
										variant="outline"
										aria-label={m.copy()}
										onClick={() =>
											navigator.clipboard.writeText(callbackUrl).catch(() => {})
										}
									>
										<CopyIcon />
									</Button>
								</div>
							</Field>
							<Field>
								<FieldLabel htmlFor="linear-client-id">
									{m.mcp_oauth_client_id()}
								</FieldLabel>
								<Input
									id="linear-client-id"
									required
									className="font-mono"
									value={clientId}
									onChange={(e) => setClientId(e.target.value)}
								/>
							</Field>
							<div className="grid gap-5 md:grid-cols-2">
								<Field data-invalid={!!errors.clientSecret || undefined}>
									<FieldLabel htmlFor="linear-client-secret">
										{m.mcp_oauth_client_secret()}
									</FieldLabel>
									<Input
										id="linear-client-secret"
										type="password"
										autoComplete="off"
										required={!installation?.clientSecretReadable}
										aria-invalid={!!errors.clientSecret || undefined}
										value={clientSecret}
										onChange={(e) => setClientSecret(e.target.value)}
										placeholder={
											installation?.clientSecretReadable
												? m.mcp_oauth_client_secret_set()
												: undefined
										}
									/>
									<FieldError>{errors.clientSecret}</FieldError>
								</Field>
								<Field data-invalid={!!errors.webhookSecret || undefined}>
									<FieldLabel htmlFor="linear-webhook-secret">
										{m.linear_webhook_secret()}
									</FieldLabel>
									<Input
										id="linear-webhook-secret"
										type="password"
										autoComplete="off"
										required={!installation?.webhookSecretReadable}
										aria-invalid={!!errors.webhookSecret || undefined}
										value={webhookSecret}
										onChange={(e) => setWebhookSecret(e.target.value)}
										placeholder={
											installation?.webhookSecretReadable
												? m.mcp_oauth_client_secret_set()
												: undefined
										}
									/>
									<FieldDescription>
										{m.linear_webhook_secret_hint()}
									</FieldDescription>
									<FieldError>{errors.webhookSecret}</FieldError>
								</Field>
							</div>
							<Button
								type="submit"
								className="self-start"
								variant={workspace ? "outline" : "default"}
								disabled={busy}
							>
								{busy && (
									<Loader2Icon
										data-icon="inline-start"
										className="animate-spin"
									/>
								)}
								{workspace ? m.linear_reinstall() : m.linear_install()}
							</Button>
							<FieldError>{errors[""]}</FieldError>
						</FieldGroup>
					</form>
				</CardContent>
			</Card>
		</ConsolePage>
	);
}
