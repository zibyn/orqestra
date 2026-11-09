import {
	type SearchProviderId,
	searchProviders,
	toolName,
} from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Picker } from "#/components/Picker";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
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
				<FieldGroup className="gap-5">
					<div className="grid gap-5 md:grid-cols-2">
						<Field>
							<FieldLabel htmlFor={`search-${id}-key`}>
								{m.api_key()}
							</FieldLabel>
							<Input
								id={`search-${id}-key`}
								type="password"
								autoComplete="off"
								required={!existing?.keyReadable}
								value={keys[id] ?? ""}
								onChange={(e) => setKeys({ ...keys, [id]: e.target.value })}
								placeholder={existing?.keyReadable ? m.api_key_set() : ""}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`search-${id}-url`}>
								{m.base_url()}
							</FieldLabel>
							<Input
								id={`search-${id}-url`}
								type="url"
								required
								value={baseUrl}
								onChange={(e) => setUrls({ ...urls, [id]: e.target.value })}
							/>
						</Field>
					</div>
					<Button
						type="submit"
						className="self-start"
						variant={existing ? "outline" : "default"}
						disabled={!!busy}
					>
						{busy === `save-${id}` && (
							<Loader2Icon data-icon="inline-start" className="animate-spin" />
						)}
						{existing ? m.save() : m.add_search_provider()}
					</Button>
				</FieldGroup>
			</form>
		);
	};

	return (
		<ConsolePage
			title={m.search_providers()}
			description={m.search_providers_hint()}
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
			{data.configured.map((p) => (
				<Card key={p.id}>
					<CardHeader>
						<CardTitle>{searchProviderName(p.id)}</CardTitle>
						<CardAction>
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
						{!p.keyReadable && (
							<Alert variant="destructive">
								<TriangleAlertIcon />
								<AlertDescription>
									{m.provider_key_unreadable()}
								</AlertDescription>
							</Alert>
						)}
						{keyForm(p.id as SearchProviderId, p)}
					</CardContent>
				</Card>
			))}
			{adding && (
				<Card>
					<CardHeader>
						<CardTitle>{m.add_search_provider()}</CardTitle>
					</CardHeader>
					<CardContent className="gap-5">
						<Picker
							label={m.search_provider()}
							value={adding}
							onChange={(v) => setAdding(v as SearchProviderId)}
							items={unconfigured.map((p) => ({ value: p.id, label: p.name }))}
						/>
						{keyForm(adding)}
					</CardContent>
				</Card>
			)}
			<FieldError>{error}</FieldError>
		</ConsolePage>
	);
}
