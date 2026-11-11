import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	BoxesIcon,
	Loader2Icon,
	PlusIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import {
	ConsolePage,
	DeleteButton,
	FormSheet,
	Item,
	ItemList,
	SheetForm,
	useSheet,
} from "#/components/ConsolePage";
import { Picker } from "#/components/Picker";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
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
import { api, ok } from "#/lib/api";
import { errorText, firstError, saved } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

const getProviders = () => ok(api().api.providers.get());

export const Route = createFileRoute("/console/providers")({
	loader: getProviders,
	component: Providers,
});

type Data = Awaited<ReturnType<typeof getProviders>>;
type CatalogProvider = Data["catalog"][number];
type Configured = Data["configured"][number];

function Providers() {
	const { catalog, configured } = Route.useLoaderData();
	const router = useRouter();
	// a Provider id to edit, or undefined to add one
	const sheet = useSheet<string | undefined>();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");
	const unconfigured = catalog.filter(
		(c) => !configured.some((p) => p.id === c.id),
	);
	const editing = configured.find((p) => p.id === sheet.item);
	const editingCatalog = catalog.find((c) => c.id === sheet.item);

	return (
		<ConsolePage
			title={m.providers()}
			description={m.providers_hint()}
			action={
				unconfigured.length > 0 && (
					<Button onClick={() => sheet.show(undefined)}>
						<PlusIcon data-icon="inline-start" />
						{m.add_provider()}
					</Button>
				)
			}
		>
			<ItemList
				empty={{
					icon: BoxesIcon,
					title: m.no_providers_title(),
					hint: m.no_providers(),
				}}
			>
				{configured.map((p) => {
					const known = catalog.find((c) => c.id === p.id);
					return (
						<Item
							key={p.id}
							title={
								<>
									{known?.name ?? p.id}
									<Badge variant="outline" className="font-mono">
										{p.id}
									</Badge>
								</>
							}
							description={`${m.models()}: ${p.enabledModels.length}`}
							actions={
								<>
									{known && (
										<Button
											size="sm"
											variant="outline"
											onClick={() => sheet.show(p.id)}
										>
											{m.edit()}
										</Button>
									)}
									<DeleteButton
										busy={busy === p.id}
										disabled={!!busy}
										onClick={async () => {
											if (!confirm(m.delete_provider_confirm())) return;
											setBusy(p.id);
											try {
												await ok(api().api.providers({ id: p.id }).delete());
												setError("");
												await router.invalidate();
											} catch (e) {
												setError(errorText(e));
											} finally {
												setBusy(undefined);
											}
										}}
									/>
								</>
							}
						>
							{!p.keyReadable && (
								<Alert variant="destructive">
									<TriangleAlertIcon />
									<AlertDescription>
										{m.provider_key_unreadable()}
									</AlertDescription>
								</Alert>
							)}
							{!known && (
								<Alert variant="destructive">
									<TriangleAlertIcon />
									<AlertDescription>
										{m.provider_not_in_catalog()}
									</AlertDescription>
								</Alert>
							)}
						</Item>
					);
				})}
			</ItemList>
			<FieldError>{error}</FieldError>
			<FormSheet
				open={sheet.open}
				onClose={sheet.close}
				title={editingCatalog?.name ?? m.add_provider()}
			>
				{editing && editingCatalog ? (
					<ProviderForm
						key={editing.id}
						choices={[editingCatalog]}
						existing={editing}
						onSaved={sheet.close}
					>
						<ModelToggles provider={editing} catalog={editingCatalog} />
					</ProviderForm>
				) : (
					unconfigured.length > 0 && (
						// once added, the sheet goes on to its Models
						<ProviderForm choices={unconfigured} onSaved={sheet.show} />
					)
				)}
			</FormSheet>
		</ConsolePage>
	);
}

/** The Catalog's Models of `provider`, each switched on or off as soon as it is toggled. */
function ModelToggles({
	provider,
	catalog,
}: {
	provider: Configured;
	catalog: CatalogProvider;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");

	return (
		<FieldSet>
			<FieldLegend variant="label">{m.models()}</FieldLegend>
			<div className="flex flex-col gap-3 rounded-lg border p-3">
				{catalog.models.map((model) => {
					const id = `${provider.id}/${model.id}`;
					const enabled = provider.enabledModels.find((e) => e.id === model.id);
					return (
						<div key={model.id} className="flex flex-col gap-1">
							<Field orientation="horizontal">
								<Switch
									id={id}
									checked={!!enabled}
									disabled={busy === id}
									onCheckedChange={async (enabled) => {
										setBusy(id);
										try {
											await ok(
												api().api.providers.models.put({
													providerId: provider.id,
													modelId: model.id,
													enabled,
												}),
											);
											setError("");
											await router.invalidate();
										} catch (e) {
											setError(errorText(e));
										} finally {
											setBusy(undefined);
										}
									}}
								/>
								<FieldLabel htmlFor={id} className="font-normal">
									{model.name}
									<span className="font-mono text-xs text-muted-foreground">
										{model.id}
									</span>
								</FieldLabel>
							</Field>
							{enabled?.cost && (
								<ModelPrice
									providerId={provider.id}
									modelId={model.id}
									cost={enabled.cost}
									custom={enabled.source === "custom"}
								/>
							)}
						</div>
					);
				})}
			</div>
			<FieldError>{error}</FieldError>
		</FieldSet>
	);
}

type Cost = NonNullable<Configured["enabledModels"][number]["cost"]>;
const costFields = [
	["input", m.price_input],
	["output", m.price_output],
	["cacheRead", m.price_cache_read],
	["cacheWrite", m.price_cache_write],
] as const;

/** An enabled Model's price in force and where it comes from; the Admin sets their own or goes back to the Catalog's. */
function ModelPrice({
	providerId,
	modelId,
	cost,
	custom,
}: {
	providerId: string;
	modelId: string;
	cost: Cost;
	custom: boolean;
}) {
	const router = useRouter();
	// the prices being edited, as typed; undefined while not editing
	const [draft, setDraft] =
		useState<Record<(typeof costFields)[number][0], string>>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function put(next: Cost | null) {
		setBusy(true);
		try {
			const error = firstError(
				await saved(
					api().api.providers.models.price.put({
						providerId,
						modelId,
						cost: next,
					}),
				),
			);
			setError(error ?? "");
			if (!error) {
				setDraft(undefined);
				await router.invalidate();
			}
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-1 pl-11 text-xs">
			<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
				<span>{m.model_price(cost)}</span>
				<Badge variant={custom ? "default" : "outline"}>
					{custom ? m.model_price_custom() : m.model_price_catalog()}
				</Badge>
				{!draft && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() =>
							setDraft({
								input: String(cost.input),
								output: String(cost.output),
								cacheRead: String(cost.cacheRead),
								cacheWrite: String(cost.cacheWrite),
							})
						}
					>
						{m.set_model_price()}
					</Button>
				)}
			</div>
			{draft && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						void put({
							input: +draft.input,
							output: +draft.output,
							cacheRead: +draft.cacheRead,
							cacheWrite: +draft.cacheWrite,
						});
					}}
				>
					<FieldSet className="w-full gap-2">
						<FieldDescription>{m.model_price_hint()}</FieldDescription>
						<div className="grid grid-cols-2 gap-2">
							{costFields.map(([key, label]) => (
								<Field key={key}>
									<FieldLabel htmlFor={`${providerId}/${modelId}/${key}`}>
										{label()}
									</FieldLabel>
									<Input
										id={`${providerId}/${modelId}/${key}`}
										type="number"
										min={0}
										step="any"
										required
										value={draft[key]}
										onChange={(e) =>
											setDraft({ ...draft, [key]: e.target.value })
										}
									/>
								</Field>
							))}
						</div>
						<div className="flex justify-end gap-2">
							{custom && (
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={busy}
									onClick={() => void put(null)}
								>
									{m.clear_model_price()}
								</Button>
							)}
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => setDraft(undefined)}
							>
								{m.cancel()}
							</Button>
							{/* the inputs' own min and required keep a bad price from saving */}
							<Button type="submit" size="sm" disabled={busy}>
								{m.save()}
							</Button>
						</div>
					</FieldSet>
				</form>
			)}
			<FieldError>{error}</FieldError>
		</div>
	);
}

/** Adds a Provider (pick it from `choices`) or edits `existing`; the API key is write-only. `children` go below the fields, outside the form. */
function ProviderForm({
	choices,
	existing,
	onSaved,
	children,
}: {
	choices: CatalogProvider[];
	existing?: Configured;
	onSaved: (id: string) => void;
	children?: ReactNode;
}) {
	const router = useRouter();
	const [providerId, setProviderId] = useState(choices[0].id);
	const catalog = choices.find((c) => c.id === providerId) ?? choices[0];
	const [apiKey, setApiKey] = useState("");
	// shown in full, the Catalog's included, so the Admin confirms where requests go
	const [editedUrl, setBaseUrl] = useState<string>();
	const baseUrl = editedUrl ?? existing?.baseUrl ?? catalog.baseUrl;
	const [modelId, setModelId] = useState<string | undefined>(
		existing?.enabledModels[0]?.id ?? catalog.models[0]?.id,
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
				const { error } = await ok(
					api().api.providers.test.post({ ...values, modelId }),
				);
				setResult(
					error
						? { ok: false, text: error }
						: { ok: true, text: m.test_connection_ok() },
				);
			} else {
				const error = firstError(await saved(api().api.providers.post(values)));
				if (error) setResult({ ok: false, text: error });
				else {
					await router.invalidate();
					onSaved(providerId);
				}
			}
		} catch (e) {
			setResult({ ok: false, text: errorText(e) });
		} finally {
			setBusy(undefined);
		}
	}

	return (
		<SheetForm
			onSubmit={() => void run("save")}
			busy={busy === "save"}
			submitLabel={existing ? m.save() : m.add_provider()}
			after={children}
			extra={
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
			}
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
				{result &&
					(result.ok ? (
						<FieldDescription>{result.text}</FieldDescription>
					) : (
						<FieldError>{result.text}</FieldError>
					))}
			</FieldGroup>
		</SheetForm>
	);
}
