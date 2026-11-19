import { createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import {
	CopyField,
	IntegrationConversations,
} from "#/components/IntegrationConversations";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { api, ok } from "#/lib/api";
import { errorText, saved, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

// An Integration whose app installs by the credentials it gave the Admin (Feishu, WeCom, GitHub, email); Linear has its own page
export const Route = createFileRoute("/console/$kind")({
	loader: async ({ params }) => {
		const [{ data, error }, agents] = await Promise.all([
			api().api({ kind: params.kind }).credentials.get(),
			ok(api().api["agent-options"].get()),
		]);
		// no Integration of that kind, or one installed by OAuth
		if (error?.status === 404) throw notFound();
		if (error) throw error;
		return { ...data, agents };
	},
	component: Integration,
});

/** `appSecret` as "App secret": a field's name is all a source gives of it. */
const label = (name: string) => {
	const words = name.replace(/([a-z\d])([A-Z])/g, "$1 $2").toLowerCase();
	return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Orqestra's app in an Integration: what the Admin enters, secrets write-only, and the workspace they connect to. */
function Integration() {
	const { kind } = Route.useParams();
	const {
		name,
		fields,
		installation,
		callbackUrl,
		webhookUrl,
		sharedScopes,
		agents,
	} = Route.useLoaderData();
	const router = useRouter();
	const [values, setValues] = useState<Record<string, string>>(() =>
		Object.fromEntries(fields.map((f) => [f.name, f.value])),
	);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const workspace = installation?.workspace;

	async function save() {
		setBusy(true);
		try {
			const result = await saved(api().api({ kind }).credentials.put(values));
			setErrors(saveErrorTexts(result.errors));
			if (!Object.keys(result.errors).length) {
				// secrets go in only: the next save keeps them unless typed again
				setValues((v) =>
					Object.fromEntries(
						fields.map((f) => [f.name, f.secret ? "" : (v[f.name] ?? "")]),
					),
				);
				await router.invalidate();
			}
		} catch (e) {
			setErrors({ "": errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<ConsolePage title={name} description={m.integration_hint({ name })}>
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
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void save();
						}}
					>
						<FieldGroup className="gap-5">
							{callbackUrl && (
								<CopyField
									id={`${kind}-callback`}
									label={m.mcp_oauth_callback()}
									value={callbackUrl}
								/>
							)}
							{webhookUrl && (
								<CopyField
									id={`${kind}-webhook`}
									label={m.linear_webhook_url()}
									value={webhookUrl}
								/>
							)}
							<div className="grid gap-5 md:grid-cols-2">
								{fields.map((f) => (
									<Field
										key={f.name}
										data-invalid={!!errors[f.name] || undefined}
									>
										<FieldLabel htmlFor={`${kind}-${f.name}`}>
											{label(f.name)}
										</FieldLabel>
										<Input
											id={`${kind}-${f.name}`}
											type={f.secret ? "password" : "text"}
											autoComplete="off"
											className={f.secret ? undefined : "font-mono"}
											required={!f.optional && !(f.secret && f.readable)}
											aria-invalid={!!errors[f.name] || undefined}
											value={values[f.name] ?? ""}
											onChange={(e) =>
												setValues((v) => ({ ...v, [f.name]: e.target.value }))
											}
											placeholder={
												f.secret && f.readable
													? m.mcp_oauth_client_secret_set()
													: f.optional
														? m.integration_optional()
														: undefined
											}
										/>
										<FieldError>{errors[f.name]}</FieldError>
									</Field>
								))}
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
								{m.integration_save()}
							</Button>
							<FieldError>{errors[""]}</FieldError>
						</FieldGroup>
					</form>
				</CardContent>
			</Card>
			{workspace && installation && (
				<IntegrationConversations
					kind={kind}
					installation={installation}
					agents={agents}
					openScopes={sharedScopes === "listed"}
					texts={{
						hint: m.integration_conversations_hint({ name }),
						repos: m.integration_scope_repos(),
						reposHint: m.integration_scope_repos_hint(),
						placeholder: "oc_5ad11d72b830411d acme/web",
						saved: m.integration_conversations_saved({ name }),
					}}
				/>
			)}
		</ConsolePage>
	);
}
