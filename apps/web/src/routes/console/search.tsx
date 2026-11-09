import {
	type SearchProviderId,
	searchProviders,
	toolName,
} from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { PlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
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
import { Picker } from "#/components/Picker";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { errorText, firstError } from "#/lib/save-errors";
import {
	deleteSearchProvider,
	getSearchProviders,
	saveSearchProvider,
	setServedBy,
} from "#/lib/search-providers";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/search")({
	loader: () => getSearchProviders(),
	component: SearchProviders,
});

type SearchConfigured = Awaited<
	ReturnType<typeof getSearchProviders>
>["configured"][number];

const searchProviderName = (id: string) =>
	searchProviders.find((p) => p.id === id)?.name ?? id;

const NONE = "none";

/** Search Providers with their write-only keys, and which one serves each Tool. */
function SearchProviders() {
	const data = Route.useLoaderData();
	const router = useRouter();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");
	// a configured Search Provider to edit, or undefined to add one
	const sheet = useSheet<SearchConfigured | undefined>();
	const unconfigured = searchProviders.filter(
		(p) => !data.configured.some((c) => c.id === p.id),
	);

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
			title={m.search_providers()}
			description={m.search_providers_hint()}
			action={
				unconfigured.length > 0 && (
					<Button onClick={() => sheet.show(undefined)}>
						<PlusIcon data-icon="inline-start" />
						{m.add_search_provider()}
					</Button>
				)
			}
		>
			<Card>
				<CardHeader>
					<CardTitle>{m.tools()}</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid gap-5 md:grid-cols-2">
						{toolName.options.map((tool) => (
							<Picker
								key={tool}
								label={m.tool_served_by({ tool })}
								error={
									data.available.includes(tool)
										? undefined
										: m.tool_unavailable({ tool })
								}
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
						))}
					</div>
				</CardContent>
			</Card>
			<ItemList
				empty={{
					icon: SearchIcon,
					title: m.no_search_providers_title(),
					hint: m.no_search_providers(),
				}}
			>
				{data.configured.map((p) => (
					<Item
						key={p.id}
						title={
							<>
								{searchProviderName(p.id)}
								<Badge variant="outline" className="font-mono">
									{p.id}
								</Badge>
							</>
						}
						description={<span className="font-mono text-xs">{p.baseUrl}</span>}
						actions={
							<>
								<Button
									size="sm"
									variant="outline"
									onClick={() => sheet.show(p)}
								>
									{m.edit()}
								</Button>
								<DeleteButton
									busy={busy === `delete-${p.id}`}
									disabled={!!busy}
									onClick={() => {
										if (confirm(m.delete_search_provider_confirm()))
											void act(`delete-${p.id}`, () =>
												deleteSearchProvider({
													data: p.id as SearchProviderId,
												}),
											);
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
					</Item>
				))}
			</ItemList>
			<FieldError>{error}</FieldError>
			<FormSheet
				open={sheet.open}
				onClose={sheet.close}
				title={
					sheet.item
						? searchProviderName(sheet.item.id)
						: m.add_search_provider()
				}
			>
				<SearchProviderForm
					existing={sheet.item}
					choices={unconfigured}
					onSaved={sheet.close}
				/>
			</FormSheet>
		</ConsolePage>
	);
}

/** Adds a Search Provider picked from `choices`, or edits `existing`; the API key is write-only. */
function SearchProviderForm({
	existing,
	choices,
	onSaved,
}: {
	existing?: SearchConfigured;
	choices: (typeof searchProviders)[number][];
	onSaved: () => void;
}) {
	const router = useRouter();
	const [id, setId] = useState(
		(existing?.id as SearchProviderId | undefined) ?? choices[0]?.id,
	);
	const [apiKey, setApiKey] = useState("");
	const [editedUrl, setUrl] = useState<string>();
	// shown in full, the official one included, so the Admin confirms where requests go
	const baseUrl =
		editedUrl ??
		existing?.baseUrl ??
		searchProviders.find((p) => p.id === id)?.baseUrl ??
		"";
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	if (!id) return null;

	async function save() {
		if (!id) return;
		setBusy(true);
		try {
			const failed = firstError(
				await saveSearchProvider({ data: { id, apiKey, baseUrl } }),
			);
			if (failed) return setError(failed);
			await router.invalidate();
			onSaved();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<SheetForm
			onSubmit={() => void save()}
			busy={busy}
			submitLabel={existing ? m.save() : m.add_search_provider()}
		>
			<FieldGroup className="gap-5">
				{!existing && (
					<Picker
						label={m.search_provider()}
						value={id}
						onChange={(v) => {
							setId(v as SearchProviderId);
							setUrl(undefined);
						}}
						items={choices.map((p) => ({ value: p.id, label: p.name }))}
					/>
				)}
				<Field>
					<FieldLabel htmlFor={`search-${id}-key`}>{m.api_key()}</FieldLabel>
					<Input
						id={`search-${id}-key`}
						type="password"
						autoComplete="off"
						required={!existing?.keyReadable}
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder={existing?.keyReadable ? m.api_key_set() : ""}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`search-${id}-url`}>{m.base_url()}</FieldLabel>
					<Input
						id={`search-${id}-url`}
						type="url"
						required
						value={baseUrl}
						onChange={(e) => setUrl(e.target.value)}
					/>
				</Field>
				<FieldError>{error}</FieldError>
			</FieldGroup>
		</SheetForm>
	);
}
