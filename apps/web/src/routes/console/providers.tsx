import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Picker } from "#/components/Picker";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Switch } from "#/components/ui/switch";
import {
	deleteProvider,
	getProviders,
	saveProvider,
	setModelEnabled,
	testProvider,
} from "#/lib/providers";
import { errorText, firstError } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/providers")({
	loader: () => getProviders(),
	component: Providers,
});

type Data = Awaited<ReturnType<typeof getProviders>>;
type CatalogProvider = Data["catalog"][number];
type Configured = Data["configured"][number];

function Providers() {
	const { catalog, configured } = Route.useLoaderData();
	const unconfigured = catalog.filter(
		(c) => !configured.some((p) => p.id === c.id),
	);

	return (
		<ConsolePage title={m.providers()} description={m.providers_hint()}>
			{configured.map((p) => (
				<ConfiguredProvider
					key={p.id}
					provider={p}
					catalog={catalog.find((c) => c.id === p.id)}
				/>
			))}
			{unconfigured.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>{m.add_provider()}</CardTitle>
					</CardHeader>
					<CardContent>
						<ProviderForm choices={unconfigured} />
					</CardContent>
				</Card>
			)}
		</ConsolePage>
	);
}

function ConfiguredProvider({
	provider,
	catalog,
}: {
	provider: Configured;
	catalog?: CatalogProvider;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");

	async function act(key: string, action: () => Promise<unknown>) {
		setBusy(key);
		try {
			await action();
			setError("");
			await router.invalidate();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(undefined);
		}
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					{catalog?.name ?? provider.id}
					<Badge variant="outline" className="font-mono">
						{provider.id}
					</Badge>
				</CardTitle>
				<CardDescription>
					{m.models()}: {provider.enabledModels.length}
				</CardDescription>
				<CardAction>
					<Button
						size="sm"
						variant="destructive"
						disabled={busy === "delete"}
						onClick={() => {
							if (confirm(m.delete_provider_confirm()))
								void act("delete", () => deleteProvider({ data: provider.id }));
						}}
					>
						{busy === "delete" && (
							<Loader2Icon data-icon="inline-start" className="animate-spin" />
						)}
						{m.delete()}
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent className="gap-6">
				{!provider.keyReadable && (
					<Alert variant="destructive">
						<TriangleAlertIcon />
						<AlertDescription>{m.provider_key_unreadable()}</AlertDescription>
					</Alert>
				)}
				{catalog ? (
					<div className="grid gap-8 lg:grid-cols-2">
						<ProviderForm choices={[catalog]} existing={provider} />
						<FieldSet>
							<FieldLegend variant="label">{m.models()}</FieldLegend>
							<div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
								{catalog.models.map((model) => {
									const id = `${provider.id}/${model.id}`;
									return (
										<Field key={model.id} orientation="horizontal">
											<Switch
												id={id}
												checked={provider.enabledModels.includes(model.id)}
												disabled={busy === id}
												onCheckedChange={(enabled) =>
													act(id, () =>
														setModelEnabled({
															data: {
																providerId: provider.id,
																modelId: model.id,
																enabled,
															},
														}),
													)
												}
											/>
											<FieldLabel htmlFor={id} className="font-normal">
												{model.name}
												<span className="font-mono text-xs text-muted-foreground">
													{model.id}
												</span>
											</FieldLabel>
										</Field>
									);
								})}
							</div>
						</FieldSet>
					</div>
				) : (
					<Alert variant="destructive">
						<TriangleAlertIcon />
						<AlertDescription>{m.provider_not_in_catalog()}</AlertDescription>
					</Alert>
				)}
				<FieldError>{error}</FieldError>
			</CardContent>
		</Card>
	);
}

/** Adds a Provider (pick it from `choices`) or edits `existing`; the API key is write-only. */
function ProviderForm({
	choices,
	existing,
}: {
	choices: CatalogProvider[];
	existing?: Configured;
}) {
	const router = useRouter();
	const [providerId, setProviderId] = useState(choices[0].id);
	const catalog = choices.find((c) => c.id === providerId) ?? choices[0];
	const [apiKey, setApiKey] = useState("");
	// shown in full, the Catalog's included, so the Admin confirms where requests go
	const [editedUrl, setBaseUrl] = useState<string>();
	const baseUrl = editedUrl ?? existing?.baseUrl ?? catalog.baseUrl;
	const [modelId, setModelId] = useState<string | undefined>(
		existing?.enabledModels[0] ?? catalog.models[0]?.id,
	);
	const [busy, setBusy] = useState<"save" | "test">();
	const [result, setResult] = useState<{ ok: boolean; text: string }>();
	const fieldId = (name: string) => `${providerId}-${name}`;
	const values = { id: providerId, apiKey, baseUrl };

	async function run(kind: "save" | "test") {
		setBusy(kind);
		try {
			if (kind === "test" && !apiKey && !existing?.keyReadable)
				setResult({ ok: false, text: m.api_key_required() });
			else if (kind === "test" && modelId) {
				const error = await testProvider({ data: { ...values, modelId } });
				setResult(
					error
						? { ok: false, text: error }
						: { ok: true, text: m.test_connection_ok() },
				);
			} else {
				const error = firstError(await saveProvider({ data: values }));
				if (error) setResult({ ok: false, text: error });
				else {
					setApiKey("");
					setResult(undefined);
					await router.invalidate();
				}
			}
		} catch (e) {
			setResult({ ok: false, text: errorText(e) });
		} finally {
			setBusy(undefined);
		}
	}

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void run("save");
			}}
		>
			<FieldGroup className="gap-5">
				{!existing && (
					<Picker
						label={m.provider()}
						value={providerId}
						onChange={(id) => {
							setProviderId(id);
							setBaseUrl(undefined);
							setModelId(choices.find((c) => c.id === id)?.models[0]?.id);
							setResult(undefined);
						}}
						items={choices.map((c) => ({ value: c.id, label: c.name }))}
					/>
				)}
				<Field>
					<FieldLabel htmlFor={fieldId("key")}>{m.api_key()}</FieldLabel>
					<Input
						id={fieldId("key")}
						type="password"
						autoComplete="off"
						required={!existing?.keyReadable}
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder={existing?.keyReadable ? m.api_key_set() : ""}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={fieldId("url")}>{m.base_url()}</FieldLabel>
					<Input
						id={fieldId("url")}
						type="url"
						required
						value={baseUrl}
						onChange={(e) => setBaseUrl(e.target.value)}
					/>
				</Field>
				{modelId && (
					<Picker
						label={m.test_model()}
						value={modelId}
						onChange={setModelId}
						items={catalog.models.map((x) => ({ value: x.id, label: x.name }))}
					/>
				)}
				<div className="flex flex-wrap gap-2">
					<Button
						type="submit"
						// one primary action per view: adding a Provider
						variant={existing ? "outline" : "default"}
						disabled={!!busy}
					>
						{busy === "save" && (
							<Loader2Icon data-icon="inline-start" className="animate-spin" />
						)}
						{existing ? m.save() : m.add_provider()}
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={!!busy || !modelId}
						onClick={() => void run("test")}
					>
						{busy === "test" && (
							<Loader2Icon data-icon="inline-start" className="animate-spin" />
						)}
						{m.test_connection()}
					</Button>
				</div>
				{result &&
					(result.ok ? (
						<FieldDescription>{result.text}</FieldDescription>
					) : (
						<FieldError>{result.text}</FieldError>
					))}
			</FieldGroup>
		</form>
	);
}
