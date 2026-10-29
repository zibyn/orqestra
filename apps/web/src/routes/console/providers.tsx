import {
	type SearchProviderId,
	searchProviders,
	toolName,
} from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Picker } from "#/components/Picker";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import {
	deleteProvider,
	getProviders,
	saveProvider,
	setModelEnabled,
	testProvider,
} from "#/lib/providers";
import {
	deleteSearchProvider,
	getSearchProviders,
	saveSearchProvider,
	setServedBy,
} from "#/lib/search-providers";
import { inlineCode } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/providers")({
	loader: async () => {
		const [providers, search] = await Promise.all([
			getProviders(),
			getSearchProviders(),
		]);
		return { ...providers, search };
	},
	component: Providers,
});

type Data = Awaited<ReturnType<typeof getProviders>>;
type SearchData = Awaited<ReturnType<typeof getSearchProviders>>;
type CatalogProvider = Data["catalog"][number];
type Configured = Data["configured"][number];

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : m.request_failed();

function Providers() {
	const { catalog, configured, search } = Route.useLoaderData();
	const unconfigured = catalog.filter(
		(c) => !configured.some((p) => p.id === c.id),
	);

	return (
		<section className="flex flex-col gap-6">
			<h1 className="text-xl font-semibold">{m.providers()}</h1>
			<p className="text-sm text-muted-foreground">{m.providers_hint()}</p>
			{configured.map((p) => (
				<ConfiguredProvider
					key={p.id}
					provider={p}
					catalog={catalog.find((c) => c.id === p.id)}
				/>
			))}
			{unconfigured.length > 0 && (
				<div className="rounded-lg border p-4 text-sm">
					<h2 className="mb-3 font-medium">{m.add_provider()}</h2>
					<ProviderForm choices={unconfigured} />
				</div>
			)}
			<SearchProviders data={search} />
		</section>
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
		<div className="flex flex-col gap-4 rounded-lg border p-4 text-sm">
			<div className="flex items-center justify-between gap-2">
				<h2 className="font-medium">
					{catalog?.name ?? provider.id}{" "}
					<code className={inlineCode}>{provider.id}</code>
				</h2>
				<Button
					size="sm"
					variant="destructive"
					disabled={busy === "delete"}
					onClick={() => {
						if (confirm(m.delete_provider_confirm()))
							void act("delete", () => deleteProvider({ data: provider.id }));
					}}
				>
					{busy === "delete" && <Loader2Icon className="animate-spin" />}
					{m.delete()}
				</Button>
			</div>
			{!provider.keyReadable && (
				<p className="text-destructive">{m.provider_key_unreadable()}</p>
			)}
			{catalog ? (
				<>
					<ProviderForm choices={[catalog]} existing={provider} />
					<div className="flex flex-col gap-2">
						<h3 className="font-medium">{m.models()}</h3>
						<ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
							{catalog.models.map((model) => {
								const id = `${provider.id}/${model.id}`;
								return (
									<li key={model.id} className="flex items-center gap-3">
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
										<Label htmlFor={id}>
											{model.name}{" "}
											<code className={inlineCode}>{model.id}</code>
										</Label>
									</li>
								);
							})}
						</ul>
					</div>
				</>
			) : (
				<p className="text-destructive">{m.provider_not_in_catalog()}</p>
			)}
			{error && <p className="text-destructive">{error}</p>}
		</div>
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
	const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? "");
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
				await saveProvider({ data: values });
				setApiKey("");
				setResult(undefined);
				await router.invalidate();
			}
		} catch (e) {
			setResult({ ok: false, text: errorText(e) });
		} finally {
			setBusy(undefined);
		}
	}

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				void run("save");
			}}
		>
			{!existing && (
				<Picker
					label={m.provider()}
					value={providerId}
					onChange={(id) => {
						setProviderId(id);
						setModelId(choices.find((c) => c.id === id)?.models[0]?.id);
						setResult(undefined);
					}}
					items={choices.map((c) => ({ value: c.id, label: c.name }))}
				/>
			)}
			<div className="flex flex-col gap-2">
				<Label htmlFor={fieldId("key")}>{m.api_key()}</Label>
				<Input
					id={fieldId("key")}
					type="password"
					autoComplete="off"
					required={!existing?.keyReadable}
					value={apiKey}
					onChange={(e) => setApiKey(e.target.value)}
					placeholder={existing?.keyReadable ? m.api_key_set() : ""}
				/>
			</div>
			<div className="flex flex-col gap-2">
				<Label htmlFor={fieldId("url")}>{m.base_url()}</Label>
				<Input
					id={fieldId("url")}
					type="url"
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder={catalog.baseUrl}
				/>
			</div>
			<div className="flex flex-wrap items-end gap-2">
				{modelId && (
					<Picker
						label={m.test_model()}
						value={modelId}
						onChange={setModelId}
						items={catalog.models.map((x) => ({ value: x.id, label: x.name }))}
					/>
				)}
				<Button
					type="button"
					variant="outline"
					disabled={!!busy || !modelId}
					onClick={() => void run("test")}
				>
					{busy === "test" && <Loader2Icon className="animate-spin" />}
					{m.test_connection()}
				</Button>
				<Button
					type="submit"
					// one primary action per view: adding a Provider
					variant={existing ? "outline" : "default"}
					disabled={!!busy}
				>
					{busy === "save" && <Loader2Icon className="animate-spin" />}
					{existing ? m.save() : m.add_provider()}
				</Button>
			</div>
			{result && (
				<p className={result.ok ? "text-muted-foreground" : "text-destructive"}>
					{result.text}
				</p>
			)}
		</form>
	);
}

const searchProviderName = (id: string) =>
	searchProviders.find((p) => p.id === id)?.name ?? id;

const NONE = "none";

/** Search Providers with their write-only keys, and which one serves each Tool. */
function SearchProviders({ data }: { data: SearchData }) {
	const router = useRouter();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");
	const unconfigured = searchProviders.filter(
		(p) => !data.configured.some((c) => c.id === p.id),
	);
	const [picked, setAdding] = useState<SearchProviderId>();
	// the picked one may have just been added
	const adding =
		unconfigured.find((p) => p.id === picked)?.id ?? unconfigured[0]?.id;
	const [keys, setKeys] = useState<Record<string, string>>({});

	async function act(key: string, action: () => Promise<unknown>) {
		setBusy(key);
		try {
			await action();
			setError("");
			setKeys({});
			await router.invalidate();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(undefined);
		}
	}

	const keyForm = (id: SearchProviderId, keyReadable: boolean) => (
		<form
			className="flex flex-wrap items-end gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				void act(`save-${id}`, () =>
					saveSearchProvider({ data: { id, apiKey: keys[id] ?? "" } }),
				);
			}}
		>
			<div className="flex flex-1 flex-col gap-2">
				<Label htmlFor={`search-${id}-key`}>{m.api_key()}</Label>
				<Input
					id={`search-${id}-key`}
					type="password"
					autoComplete="off"
					required
					value={keys[id] ?? ""}
					onChange={(e) => setKeys({ ...keys, [id]: e.target.value })}
					placeholder={keyReadable ? m.api_key_set() : ""}
				/>
			</div>
			<Button type="submit" variant="outline" disabled={!!busy}>
				{busy === `save-${id}` && <Loader2Icon className="animate-spin" />}
				{keyReadable ? m.save() : m.add_search_provider()}
			</Button>
		</form>
	);

	return (
		<>
			<h2 className="mt-4 text-lg font-semibold">{m.search_providers()}</h2>
			<p className="text-sm text-muted-foreground">
				{m.search_providers_hint()}
			</p>
			<div className="flex flex-col gap-4 rounded-lg border p-4 text-sm">
				{toolName.options.map((tool) => (
					<div key={tool} className="flex flex-col gap-2">
						<Picker
							label={m.tool_served_by({ tool })}
							value={data.servedBy[tool] ?? NONE}
							onChange={(v) =>
								act(`tool-${tool}`, () =>
									setServedBy({
										data: {
											tool,
											provider: v === NONE ? null : (v as SearchProviderId),
										},
									}),
								)
							}
							items={[
								{ value: NONE, label: m.none() },
								...data.configured.map((c) => ({
									value: c.id,
									label: searchProviderName(c.id),
								})),
							]}
						/>
						{!data.available.includes(tool) && (
							<p className="text-destructive">{m.tool_unavailable({ tool })}</p>
						)}
					</div>
				))}
			</div>
			{data.configured.map((p) => (
				<div
					key={p.id}
					className="flex flex-col gap-4 rounded-lg border p-4 text-sm"
				>
					<div className="flex items-center justify-between gap-2">
						<h3 className="font-medium">{searchProviderName(p.id)}</h3>
						<Button
							size="sm"
							variant="destructive"
							disabled={!!busy}
							onClick={() => {
								if (confirm(m.delete_search_provider_confirm()))
									void act(`delete-${p.id}`, () =>
										deleteSearchProvider({ data: p.id as SearchProviderId }),
									);
							}}
						>
							{busy === `delete-${p.id}` && (
								<Loader2Icon className="animate-spin" />
							)}
							{m.delete()}
						</Button>
					</div>
					{!p.keyReadable && (
						<p className="text-destructive">{m.provider_key_unreadable()}</p>
					)}
					{keyForm(p.id as SearchProviderId, p.keyReadable)}
				</div>
			))}
			{adding && (
				<div className="flex flex-col gap-4 rounded-lg border p-4 text-sm">
					<h3 className="font-medium">{m.add_search_provider()}</h3>
					<Picker
						label={m.search_provider()}
						value={adding}
						onChange={(v) => setAdding(v as SearchProviderId)}
						items={unconfigured.map((p) => ({ value: p.id, label: p.name }))}
					/>
					{keyForm(adding, false)}
				</div>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
		</>
	);
}
