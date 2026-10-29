import {
	type SearchProviderId,
	searchProviders,
	slugify,
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
	deleteMcpServer,
	getMcpServers,
	saveMcpServer,
	setMcpServerEnabled,
} from "#/lib/mcp-servers";
import {
	deleteProvider,
	getProviders,
	saveProvider,
	setModelEnabled,
	testProvider,
} from "#/lib/providers";
import { saveErrorTexts } from "#/lib/save-errors";
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
		const [providers, search, mcpServers] = await Promise.all([
			getProviders(),
			getSearchProviders(),
			getMcpServers(),
		]);
		return { ...providers, search, mcpServers };
	},
	component: Providers,
});

type Data = Awaited<ReturnType<typeof getProviders>>;
type SearchData = Awaited<ReturnType<typeof getSearchProviders>>;
type SearchConfigured = SearchData["configured"][number];
type CatalogProvider = Data["catalog"][number];
type Configured = Data["configured"][number];

type McpTestResult = NonNullable<
	Awaited<ReturnType<typeof saveMcpServer>>["test"]
>;

/** The first field error of a save, translated; undefined when it was saved. */
const firstError = (result: { errors: Parameters<typeof saveErrorTexts>[0] }) =>
	Object.values(saveErrorTexts(result.errors))[0];

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : m.request_failed();

function Providers() {
	const { catalog, configured, search, mcpServers } = Route.useLoaderData();
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
			<McpServers servers={mcpServers} />
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
						setBaseUrl(undefined);
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
					required
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
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
	// unsaved form values by Search Provider id
	const [keys, setKeys] = useState<Record<string, string>>({});
	const [urls, setUrls] = useState<Record<string, string>>({});

	async function act(key: string, action: () => Promise<unknown>) {
		setBusy(key);
		try {
			await action();
			setError("");
			setKeys({});
			setUrls({});
			await router.invalidate();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(undefined);
		}
	}

	/** Adds Search Provider `id`, or edits `existing`; the API key is write-only. */
	const keyForm = (id: SearchProviderId, existing?: SearchConfigured) => {
		// shown in full, the official one included, so the Admin confirms where requests go
		const baseUrl =
			urls[id] ??
			existing?.baseUrl ??
			searchProviders.find((p) => p.id === id)?.baseUrl ??
			"";
		return (
			<form
				className="flex flex-col gap-4"
				onSubmit={(e) => {
					e.preventDefault();
					void act(`save-${id}`, async () => {
						const error = firstError(
							await saveSearchProvider({
								data: {
									id,
									apiKey: keys[id] ?? "",
									baseUrl,
								},
							}),
						);
						if (error) throw new Error(error);
					});
				}}
			>
				<div className="flex flex-col gap-2">
					<Label htmlFor={`search-${id}-key`}>{m.api_key()}</Label>
					<Input
						id={`search-${id}-key`}
						type="password"
						autoComplete="off"
						required={!existing?.keyReadable}
						value={keys[id] ?? ""}
						onChange={(e) => setKeys({ ...keys, [id]: e.target.value })}
						placeholder={existing?.keyReadable ? m.api_key_set() : ""}
					/>
				</div>
				<div className="flex flex-col gap-2">
					<Label htmlFor={`search-${id}-url`}>{m.base_url()}</Label>
					<Input
						id={`search-${id}-url`}
						type="url"
						required
						value={baseUrl}
						onChange={(e) => setUrls({ ...urls, [id]: e.target.value })}
					/>
				</div>
				<Button
					type="submit"
					className="self-start"
					variant={existing ? "outline" : "default"}
					disabled={!!busy}
				>
					{busy === `save-${id}` && <Loader2Icon className="animate-spin" />}
					{existing ? m.save() : m.add_search_provider()}
				</Button>
			</form>
		);
	};

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
					{keyForm(p.id as SearchProviderId, p)}
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
					{keyForm(adding)}
				</div>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
		</>
	);
}

type McpServer = Awaited<ReturnType<typeof getMcpServers>>[number];

/** MCP Servers with their write-only header values. */
function McpServers({ servers }: { servers: McpServer[] }) {
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
		<>
			<h2 className="mt-4 text-lg font-semibold">{m.mcp_servers()}</h2>
			<p className="text-sm text-muted-foreground">{m.mcp_servers_hint()}</p>
			{servers.map((s) => (
				<div
					key={s.id}
					className="flex flex-col gap-4 rounded-lg border p-4 text-sm"
				>
					<div className="flex items-center justify-between gap-2">
						<h3 className="font-medium">
							{s.name} <code className={inlineCode}>{s.id}</code>
						</h3>
						<div className="flex items-center gap-3">
							<Switch
								id={`mcp-${s.id}-enabled`}
								checked={s.enabled}
								disabled={!!busy}
								onCheckedChange={(enabled) =>
									act(`enable-${s.id}`, () =>
										setMcpServerEnabled({ data: { id: s.id, enabled } }),
									)
								}
							/>
							<Label htmlFor={`mcp-${s.id}-enabled`}>
								{m.mcp_server_enabled()}
							</Label>
							<Button
								size="sm"
								variant="destructive"
								disabled={!!busy}
								onClick={() => {
									if (confirm(m.delete_mcp_server_confirm()))
										void act(`delete-${s.id}`, () =>
											deleteMcpServer({ data: s.id }),
										);
								}}
							>
								{busy === `delete-${s.id}` && (
									<Loader2Icon className="animate-spin" />
								)}
								{m.delete()}
							</Button>
						</div>
					</div>
					{s.headers.some((h) => !h.readable) && (
						<p className="text-destructive">{m.mcp_header_unreadable()}</p>
					)}
					<McpServerForm existing={s} />
				</div>
			))}
			<div className="flex flex-col gap-4 rounded-lg border p-4 text-sm">
				<h3 className="font-medium">{m.add_mcp_server()}</h3>
				<McpServerForm />
			</div>
			{error && <p className="text-sm text-destructive">{error}</p>}
		</>
	);
}

/** Adds an MCP Server or edits `existing`; a blank header value keeps the stored one. */
function McpServerForm({ existing }: { existing?: McpServer }) {
	const router = useRouter();
	const [name, setName] = useState(existing?.name ?? "");
	const [id, setId] = useState(existing?.id ?? "");
	const [idEdited, setIdEdited] = useState(false);
	const [url, setUrl] = useState(existing?.url ?? "");
	const blank = () =>
		existing?.headers.map((h) => ({ name: h.name, value: "" })) ?? [];
	const [headers, setHeaders] = useState(blank);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [test, setTest] = useState<McpTestResult>();
	const fieldId = (field: string) => `mcp-${existing?.id ?? "new"}-${field}`;
	const setHeader = (i: number, fields: Partial<(typeof headers)[number]>) =>
		setHeaders(headers.map((h, j) => (j === i ? { ...h, ...fields } : h)));

	async function save() {
		setBusy(true);
		setTest(undefined);
		try {
			const result = await saveMcpServer({
				data: {
					id,
					create: !existing,
					name,
					url,
					enabled: existing?.enabled ?? true,
					headers,
				},
			});
			setErrors(saveErrorTexts(result.errors));
			setTest(result.test);
			if (!Object.keys(result.errors).length) {
				if (!existing) {
					setName("");
					setId("");
					setIdEdited(false);
					setUrl("");
				}
				setHeaders(blank());
				await router.invalidate();
			}
		} catch (e) {
			setErrors({ "": errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<div className="flex flex-col gap-2">
				<Label htmlFor={fieldId("name")}>{m.mcp_server_name()}</Label>
				<Input
					id={fieldId("name")}
					required
					value={name}
					onChange={(e) => {
						setName(e.target.value);
						if (!existing && !idEdited) setId(slugify(e.target.value));
					}}
				/>
			</div>
			<div className="flex flex-col gap-2">
				<Label htmlFor={fieldId("id")}>{m.mcp_server_id()}</Label>
				{!existing && (
					<p className="text-muted-foreground">{m.mcp_server_id_hint()}</p>
				)}
				<Input
					id={fieldId("id")}
					required
					disabled={!!existing}
					pattern="[a-z0-9][a-z0-9\-]*"
					value={id}
					onChange={(e) => {
						setId(e.target.value);
						setIdEdited(true);
					}}
				/>
				{errors.id && <p className="text-destructive">{errors.id}</p>}
			</div>
			<div className="flex flex-col gap-2">
				<Label htmlFor={fieldId("url")}>{m.mcp_server_url()}</Label>
				<Input
					id={fieldId("url")}
					type="url"
					required
					pattern="https?://.*"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
				/>
			</div>
			<fieldset className="flex flex-col gap-2">
				<legend className="mb-2 font-medium">{m.mcp_headers()}</legend>
				{existing && (
					<p className="text-muted-foreground">{m.mcp_headers_hint()}</p>
				)}
				{headers.map((h, i) => {
					const stored = existing?.headers.find((s) => s.name === h.name);
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved
						<div key={i} className="flex flex-wrap items-center gap-2">
							<Input
								aria-label={m.header_name()}
								placeholder={m.header_name()}
								className="w-48"
								required
								value={h.name}
								onChange={(e) => setHeader(i, { name: e.target.value })}
							/>
							<Input
								aria-label={m.header_value()}
								type="password"
								autoComplete="off"
								className="flex-1"
								required={!stored?.readable}
								placeholder={
									stored?.readable ? m.header_value_set() : m.header_value()
								}
								value={h.value}
								onChange={(e) => setHeader(i, { value: e.target.value })}
							/>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
							>
								{m.remove()}
							</Button>
						</div>
					);
				})}
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="self-start"
					onClick={() => setHeaders([...headers, { name: "", value: "" }])}
				>
					{m.add_header()}
				</Button>
				{errors.headers && <p className="text-destructive">{errors.headers}</p>}
			</fieldset>
			<Button
				type="submit"
				className="self-start"
				variant={existing ? "outline" : "default"}
				disabled={busy}
			>
				{busy && <Loader2Icon className="animate-spin" />}
				{existing ? m.save() : m.add_mcp_server()}
			</Button>
			{test && <McpTestOutcome result={test} />}
			{errors[""] && <p className="text-destructive">{errors[""]}</p>}
		</form>
	);
}

/** The Tools a just-saved MCP Server offers, or why connecting to it failed. */
function McpTestOutcome({ result }: { result: McpTestResult }) {
	if (!result.ok) {
		const message = {
			auth: m.mcp_test_auth,
			unreachable: m.mcp_test_unreachable,
			timeout: m.mcp_test_timeout,
			failed: m.mcp_test_failed,
		}[result.reason];
		return (
			<p className="text-destructive">{message({ detail: result.detail })}</p>
		);
	}
	if (!result.tools.length) return <p>{m.mcp_test_no_tools()}</p>;
	return (
		<div className="flex flex-col gap-2">
			<p>{m.mcp_test_ok()}</p>
			<ul className="flex flex-col gap-1">
				{result.tools.map((t) => (
					<li key={t.name}>
						<code className={inlineCode}>{t.name}</code>
						{t.description && (
							<span className="text-muted-foreground"> {t.description}</span>
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
