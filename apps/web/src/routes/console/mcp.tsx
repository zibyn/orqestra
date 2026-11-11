import { slugify } from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	CheckCircle2Icon,
	ChevronDownIcon,
	CopyIcon,
	PlugIcon,
	PlusIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import {
	ConsolePage,
	DeleteButton,
	FormSheet,
	Item,
	ItemList,
	SheetForm,
	useSheet,
} from "#/components/ConsolePage";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
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
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import { api, ok } from "#/lib/api";
import { errorText, saved, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

const getMcpServers = () => ok(api().api["mcp-servers"].get());
const saveMcpServer = (
	server: Parameters<ReturnType<typeof api>["api"]["mcp-servers"]["post"]>[0],
) => saved(api().api["mcp-servers"].post(server));

export const Route = createFileRoute("/console/mcp")({
	loader: getMcpServers,
	component: McpServers,
});

type McpServer = Awaited<ReturnType<typeof getMcpServers>>[number];
type McpTestResult = NonNullable<
	Awaited<ReturnType<typeof saveMcpServer>>["test"]
>;

// shortcut: assumes the console is opened at ORQESTRA_URL (Caddy serves /api there); upgrade by having the api send it if they can differ
const callbackUrl = `${globalThis.location?.origin}/api/connections/callback`;

/** MCP Servers with their write-only header values. */
function McpServers() {
	const servers = Route.useLoaderData();
	const router = useRouter();
	const sheet = useSheet<McpServer | undefined>();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");
	// the connection test of the server saved last, shown under its row
	const [tested, setTested] = useState<{ id: string; result: McpTestResult }>();

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
		<ConsolePage
			title={m.mcp_servers()}
			description={m.mcp_servers_hint()}
			action={
				<Button onClick={() => sheet.show(undefined)}>
					<PlusIcon data-icon="inline-start" />
					{m.add_mcp_server()}
				</Button>
			}
		>
			<ItemList
				empty={{
					icon: PlugIcon,
					title: m.no_mcp_servers_title(),
					hint: m.no_mcp_servers(),
				}}
			>
				{servers.map((s) => (
					<Item
						key={s.id}
						title={
							<>
								{s.name}
								<Badge variant="outline" className="font-mono">
									{s.id}
								</Badge>
								{s.auth === "oauth" && (
									<Badge variant="secondary">{m.mcp_auth_oauth()}</Badge>
								)}
							</>
						}
						description={<span className="font-mono text-xs">{s.url}</span>}
						actions={
							<>
								<Switch
									aria-label={m.mcp_server_enabled()}
									checked={s.enabled}
									disabled={!!busy}
									onCheckedChange={(enabled) =>
										act(`enable-${s.id}`, () =>
											ok(
												api().api["mcp-servers"].enabled.put({
													id: s.id,
													enabled,
												}),
											),
										)
									}
								/>
								<Button
									size="sm"
									variant="outline"
									onClick={() => sheet.show(s)}
								>
									{m.edit()}
								</Button>
								<DeleteButton
									busy={busy === `delete-${s.id}`}
									disabled={!!busy}
									onClick={() => {
										if (confirm(m.delete_mcp_server_confirm()))
											void act(`delete-${s.id}`, () =>
												ok(api().api["mcp-servers"]({ id: s.id }).delete()),
											);
									}}
								/>
							</>
						}
					>
						{s.headers.some((h) => !h.readable) && (
							<Alert variant="destructive">
								<TriangleAlertIcon />
								<AlertDescription>{m.mcp_header_unreadable()}</AlertDescription>
							</Alert>
						)}
						{s.oauthClientSecret?.readable === false && (
							<Alert variant="destructive">
								<TriangleAlertIcon />
								<AlertDescription>
									{m.mcp_oauth_client_secret_unreadable()}
								</AlertDescription>
							</Alert>
						)}
						{tested?.id === s.id && <McpTestOutcome result={tested.result} />}
					</Item>
				))}
			</ItemList>
			<FieldError>{error}</FieldError>
			<FormSheet
				open={sheet.open}
				onClose={sheet.close}
				title={sheet.item?.name ?? m.add_mcp_server()}
			>
				<McpServerForm
					existing={sheet.item}
					onSaved={(id, result) => {
						setTested(result && { id, result });
						sheet.close();
					}}
				/>
			</FormSheet>
		</ConsolePage>
	);
}

/** Adds an MCP Server or edits `existing`; a blank header value keeps the stored one. */
function McpServerForm({
	existing,
	onSaved,
}: {
	existing?: McpServer;
	onSaved: (id: string, test?: McpTestResult) => void;
}) {
	const router = useRouter();
	const [name, setName] = useState(existing?.name ?? "");
	const [id, setId] = useState(existing?.id ?? "");
	const [idEdited, setIdEdited] = useState(false);
	const [url, setUrl] = useState(existing?.url ?? "");
	const [headers, setHeaders] = useState(
		() => existing?.headers.map((h) => ({ name: h.name, value: "" })) ?? [],
	);
	const [auth, setAuth] = useState(existing?.auth ?? "shared");
	const [clientId, setClientId] = useState(existing?.oauthClientId ?? "");
	const [clientSecret, setClientSecret] = useState("");
	const [clientOpen, setClientOpen] = useState(!!existing?.oauthClientId);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const fieldId = (field: string) => `mcp-${existing?.id ?? "new"}-${field}`;
	const setHeader = (i: number, fields: Partial<(typeof headers)[number]>) =>
		setHeaders(headers.map((h, j) => (j === i ? { ...h, ...fields } : h)));

	async function save() {
		setBusy(true);
		try {
			const result = await saveMcpServer({
				id,
				create: !existing,
				name,
				url,
				enabled: existing?.enabled ?? true,
				auth,
				oauthClientId: clientId,
				oauthClientSecret: clientSecret,
				headers,
			});
			setErrors(saveErrorTexts(result.errors));
			if (!Object.keys(result.errors).length) {
				await router.invalidate();
				onSaved(id, result.test);
			}
		} catch (e) {
			setErrors({ "": errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<SheetForm
			onSubmit={() => void save()}
			busy={busy}
			submitLabel={existing ? m.save() : m.add_mcp_server()}
		>
			<FieldGroup className="gap-5">
				<Field>
					<FieldLabel htmlFor={fieldId("name")}>
						{m.mcp_server_name()}
					</FieldLabel>
					<Input
						id={fieldId("name")}
						required
						value={name}
						onChange={(e) => {
							setName(e.target.value);
							if (!existing && !idEdited) setId(slugify(e.target.value));
						}}
					/>
				</Field>
				<Field data-invalid={!!errors.id || undefined}>
					<FieldLabel htmlFor={fieldId("id")}>{m.mcp_server_id()}</FieldLabel>
					<Input
						id={fieldId("id")}
						required
						disabled={!!existing}
						className="font-mono"
						aria-invalid={!!errors.id || undefined}
						pattern="[a-z0-9][a-z0-9\-]*"
						value={id}
						onChange={(e) => {
							setId(e.target.value);
							setIdEdited(true);
						}}
					/>
					{!existing && (
						<FieldDescription>{m.mcp_server_id_hint()}</FieldDescription>
					)}
					<FieldError>{errors.id}</FieldError>
				</Field>
				<Field>
					<FieldLabel htmlFor={fieldId("url")}>{m.mcp_server_url()}</FieldLabel>
					<Input
						id={fieldId("url")}
						type="url"
						required
						pattern="https?://.*"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
					/>
				</Field>
				<FieldSet className="gap-3">
					<FieldLegend variant="label">{m.mcp_auth()}</FieldLegend>
					<ToggleGroup
						variant="outline"
						spacing={0}
						className="w-full"
						value={[auth]}
						onValueChange={([k]) => k && setAuth(k as typeof auth)}
					>
						<ToggleGroupItem value="shared" className="flex-1">
							{m.mcp_auth_shared()}
						</ToggleGroupItem>
						<ToggleGroupItem value="oauth" className="flex-1">
							{m.mcp_auth_oauth()}
						</ToggleGroupItem>
					</ToggleGroup>
					<FieldDescription>
						{auth === "shared"
							? m.mcp_auth_shared_hint()
							: m.mcp_auth_oauth_hint()}
					</FieldDescription>
					{/* only an oauth server has Connections to lose */}
					{existing?.auth === "oauth" && (
						<Alert>
							<AlertDescription>{m.mcp_auth_change_warning()}</AlertDescription>
						</Alert>
					)}
					{auth === "oauth" && (
						<Collapsible open={clientOpen} onOpenChange={setClientOpen}>
							<CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
								<ChevronDownIcon
									className={`size-4 transition-transform ${clientOpen ? "" : "-rotate-90"}`}
								/>
								{m.mcp_oauth_client()}
							</CollapsibleTrigger>
							<CollapsibleContent className="flex flex-col gap-3 pt-3">
								<FieldDescription>{m.mcp_oauth_client_hint()}</FieldDescription>
								<Field>
									<FieldLabel htmlFor={fieldId("callback")}>
										{m.mcp_oauth_callback()}
									</FieldLabel>
									<div className="flex gap-2">
										<Input
											id={fieldId("callback")}
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
												navigator.clipboard
													.writeText(callbackUrl)
													.catch(() => {})
											}
										>
											<CopyIcon />
										</Button>
									</div>
								</Field>
								<Field>
									<FieldLabel htmlFor={fieldId("client-id")}>
										{m.mcp_oauth_client_id()}
									</FieldLabel>
									<Input
										id={fieldId("client-id")}
										className="font-mono"
										value={clientId}
										onChange={(e) => setClientId(e.target.value)}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor={fieldId("client-secret")}>
										{m.mcp_oauth_client_secret()}
									</FieldLabel>
									<Input
										id={fieldId("client-secret")}
										type="password"
										autoComplete="off"
										placeholder={
											existing?.oauthClientSecret?.readable
												? m.mcp_oauth_client_secret_set()
												: undefined
										}
										value={clientSecret}
										onChange={(e) => setClientSecret(e.target.value)}
									/>
								</Field>
							</CollapsibleContent>
						</Collapsible>
					)}
				</FieldSet>
				<FieldSet className="gap-3">
					<FieldLegend variant="label">{m.mcp_headers()}</FieldLegend>
					{auth === "oauth" && (
						<FieldDescription>{m.mcp_oauth_headers_hint()}</FieldDescription>
					)}
					{existing && (
						<FieldDescription>{m.mcp_headers_hint()}</FieldDescription>
					)}
					{headers.map((h, i) => {
						const stored = existing?.headers.find((s) => s.name === h.name);
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved
							<div key={i} className="flex items-center gap-2">
								<Input
									aria-label={m.header_name()}
									placeholder={m.header_name()}
									className="w-40 font-mono"
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
									size="icon-sm"
									variant="ghost"
									aria-label={m.remove()}
									onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
								>
									<XIcon />
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
						<PlusIcon data-icon="inline-start" />
						{m.add_header()}
					</Button>
					<FieldError>{errors.headers}</FieldError>
				</FieldSet>
				<FieldError>{errors[""]}</FieldError>
			</FieldGroup>
		</SheetForm>
	);
}

/** The Tools a just-saved MCP Server offers, or why connecting to it failed. */
function McpTestOutcome({ result }: { result: McpTestResult }) {
	if (!result.ok) {
		const message = result.step
			? {
					resource_metadata: m.mcp_test_oauth_resource_metadata,
					authorization_server_metadata:
						m.mcp_test_oauth_authorization_server_metadata,
					pkce: m.mcp_test_oauth_pkce,
				}[result.step]
			: {
					auth: m.mcp_test_auth,
					unreachable: m.mcp_test_unreachable,
					timeout: m.mcp_test_timeout,
					failed: m.mcp_test_failed,
				}[result.reason];
		return (
			<Alert variant="destructive">
				<TriangleAlertIcon />
				<AlertDescription>
					{message({ detail: result.detail })}
				</AlertDescription>
			</Alert>
		);
	}
	if ("authorizationServer" in result)
		return (
			<Alert>
				<CheckCircle2Icon />
				<AlertTitle>
					{m.mcp_test_oauth_ok({ issuer: result.authorizationServer })}
				</AlertTitle>
				<AlertDescription>{m.mcp_test_oauth_ok_hint()}</AlertDescription>
			</Alert>
		);
	return (
		<Alert>
			<CheckCircle2Icon />
			<AlertTitle>
				{result.tools.length ? m.mcp_test_ok() : m.mcp_test_no_tools()}
			</AlertTitle>
			{result.tools.length > 0 && (
				<AlertDescription>
					<ul className="flex flex-col gap-1">
						{result.tools.map((t) => (
							<li key={t.name}>
								<span className="font-mono text-foreground">{t.name}</span>
								{t.description && <span> {t.description}</span>}
							</li>
						))}
					</ul>
				</AlertDescription>
			)}
		</Alert>
	);
}
