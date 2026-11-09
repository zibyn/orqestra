import { slugify } from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	CheckCircle2Icon,
	Loader2Icon,
	PlusIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
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
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import {
	deleteMcpServer,
	getMcpServers,
	saveMcpServer,
	setMcpServerEnabled,
} from "#/lib/mcp-servers";
import { errorText, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/mcp")({
	loader: () => getMcpServers(),
	component: McpServers,
});

type McpServer = Awaited<ReturnType<typeof getMcpServers>>[number];
type McpTestResult = NonNullable<
	Awaited<ReturnType<typeof saveMcpServer>>["test"]
>;

/** MCP Servers with their write-only header values. */
function McpServers() {
	const servers = Route.useLoaderData();
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
		<ConsolePage title={m.mcp_servers()} description={m.mcp_servers_hint()}>
			{servers.map((s) => (
				<Card key={s.id}>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							{s.name}
							<Badge variant="outline" className="font-mono">
								{s.id}
							</Badge>
						</CardTitle>
						<CardDescription className="truncate font-mono text-xs">
							{s.url}
						</CardDescription>
						<CardAction className="flex items-center gap-4">
							<div className="flex items-center gap-2">
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
							</div>
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
									<Loader2Icon
										data-icon="inline-start"
										className="animate-spin"
									/>
								)}
								{m.delete()}
							</Button>
						</CardAction>
					</CardHeader>
					<CardContent className="gap-5">
						{s.headers.some((h) => !h.readable) && (
							<Alert variant="destructive">
								<TriangleAlertIcon />
								<AlertDescription>{m.mcp_header_unreadable()}</AlertDescription>
							</Alert>
						)}
						<McpServerForm existing={s} />
					</CardContent>
				</Card>
			))}
			<Card>
				<CardHeader>
					<CardTitle>{m.add_mcp_server()}</CardTitle>
				</CardHeader>
				<CardContent>
					<McpServerForm />
				</CardContent>
			</Card>
			<FieldError>{error}</FieldError>
		</ConsolePage>
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
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<FieldGroup className="gap-5">
				<div className="grid gap-5 md:grid-cols-2">
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
				</div>
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
					<FieldLegend variant="label">{m.mcp_headers()}</FieldLegend>
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
									className="w-40 font-mono sm:w-56"
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
				<Button
					type="submit"
					className="self-start"
					variant={existing ? "outline" : "default"}
					disabled={busy}
				>
					{busy && (
						<Loader2Icon data-icon="inline-start" className="animate-spin" />
					)}
					{existing ? m.save() : m.add_mcp_server()}
				</Button>
				{test && <McpTestOutcome result={test} />}
				<FieldError>{errors[""]}</FieldError>
			</FieldGroup>
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
			<Alert variant="destructive">
				<TriangleAlertIcon />
				<AlertDescription>
					{message({ detail: result.detail })}
				</AlertDescription>
			</Alert>
		);
	}
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
