import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	CheckCircle2Icon,
	CopyIcon,
	Loader2Icon,
	TriangleAlertIcon,
} from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Picker } from "#/components/Picker";
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
import { Textarea } from "#/components/ui/textarea";
import { api, ok } from "#/lib/api";
import { errorText, saved, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/linear")({
	// where the api's callback sends the Admin back from Linear
	validateSearch: (search): { error?: string } =>
		typeof search.error === "string" ? { error: search.error } : {},
	loader: async () => {
		const [linear, agents] = await Promise.all([
			ok(api().api.linear.get()),
			ok(api().api["agent-options"].get()),
		]);
		return { ...linear, agents };
	},
	component: Linear,
});

const callbackErrors: Record<string, () => string> = {
	state_invalid: m.linear_state_invalid,
	denied: m.linear_denied,
	failed: m.linear_failed,
};

/** Orqestra's Linear app: its credentials, write-only secrets, and the workspace it is installed in. */
function Linear() {
	const { installation, callbackUrl, webhookUrl } = Route.useLoaderData();
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
							<CopyField
								id="linear-callback"
								label={m.mcp_oauth_callback()}
								value={callbackUrl}
							/>
							<CopyField
								id="linear-webhook"
								label={m.linear_webhook_url()}
								value={webhookUrl}
								hint={m.linear_webhook_url_hint()}
							/>
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
			{workspace && <LinearConversations />}
		</ConsolePage>
	);
}

function CopyField({
	id,
	label,
	value,
	hint,
}: {
	id: string;
	label: string;
	value: string;
	hint?: string;
}) {
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<div className="flex gap-2">
				<Input id={id} readOnly className="font-mono" value={value} />
				<Button
					type="button"
					size="icon"
					variant="outline"
					aria-label={m.copy()}
					onClick={() => navigator.clipboard.writeText(value).catch(() => {})}
				>
					<CopyIcon />
				</Button>
			</div>
			{hint && <FieldDescription>{hint}</FieldDescription>}
		</Field>
	);
}

/** The Agent of the Conversations Linear opens, and the repository each team's issues are worked in, one `TEAM owner/repo` a line. */
function LinearConversations() {
	const { installation, agents } = Route.useLoaderData();
	const router = useRouter();
	const pickable = agents.filter((a) => a.pickable);
	const [agentId, setAgentId] = useState(
		installation?.defaultAgentId ??
			(pickable.find((a) => a.default) ?? pickable[0])?.id ??
			"",
	);
	const [repos, setRepos] = useState(
		Object.entries(installation?.teamRepos ?? {})
			.map(([team, repo]) => `${team} ${repo}`)
			.join("\n"),
	);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});

	async function save() {
		setBusy(true);
		setDone(false);
		try {
			const teamRepos = Object.fromEntries(
				repos
					.split("\n")
					.map((line) => line.trim().split(/\s+/))
					.filter(([team]) => team)
					.map(([team, repo = ""]) => [team, repo]),
			);
			const result = await saved(
				api().api.linear.conversations.put({
					defaultAgentId: agentId,
					teamRepos,
				}),
			);
			setErrors(saveErrorTexts(result.errors));
			setDone(!Object.keys(result.errors).length);
			await router.invalidate();
		} catch (e) {
			setErrors({ "": errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	// "teamRepos.OPS": the team whose line it refused
	const reposError = Object.entries(errors)
		.filter(([field]) => field.startsWith("teamRepos"))
		.map(([field, text]) =>
			`${field.replace(/^teamRepos\.?/, "")} ${text}`.trim(),
		)
		.join("; ");

	return (
		<Card>
			<CardContent>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void save();
					}}
				>
					<FieldGroup className="gap-5">
						<FieldDescription>{m.linear_conversations_hint()}</FieldDescription>
						<Picker
							label={m.linear_agent()}
							error={errors.defaultAgentId}
							value={agentId}
							onChange={setAgentId}
							items={pickable.map((a) => ({ value: a.id, label: a.name }))}
						/>
						<Field data-invalid={!!reposError || undefined}>
							<FieldLabel htmlFor="linear-team-repos">
								{m.linear_team_repos()}
							</FieldLabel>
							<Textarea
								id="linear-team-repos"
								className="font-mono"
								placeholder="ENG acme/web"
								aria-invalid={!!reposError || undefined}
								value={repos}
								onChange={(e) => setRepos(e.target.value)}
							/>
							<FieldDescription>{m.linear_team_repos_hint()}</FieldDescription>
							<FieldError>{reposError}</FieldError>
						</Field>
						<Button type="submit" className="self-start" disabled={busy}>
							{busy && (
								<Loader2Icon
									data-icon="inline-start"
									className="animate-spin"
								/>
							)}
							{m.save()}
						</Button>
						{done && (
							<Alert>
								<CheckCircle2Icon />
								<AlertDescription>
									{m.linear_conversations_saved()}
								</AlertDescription>
							</Alert>
						)}
						<FieldError>{errors[""]}</FieldError>
					</FieldGroup>
				</form>
			</CardContent>
		</Card>
	);
}
