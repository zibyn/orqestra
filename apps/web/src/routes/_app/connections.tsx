import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	CheckCircle2Icon,
	CircleDashedIcon,
	ExternalLinkIcon,
	LinkIcon,
	PlugIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ConsolePage, Item, ItemList } from "#/components/ConsolePage";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { api, ok } from "#/lib/api";
import { errorText } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

/** Whom a private link the app sent links, as the User confirms it; `invalid` once it is expired or forged. */
const linkInfo = async (link: string) => {
	const { data } = await api().api.integrations.link.get({ query: { link } });
	return data ?? { invalid: true as const };
};

const getConnections = async (link?: string) => {
	const [rows, integrations, pending] = await Promise.all([
		ok(api().api.connections.get()),
		ok(api().api.integrations.get()),
		link ? linkInfo(link) : undefined,
	]);
	return {
		rows,
		integrations: integrations.filter((i) => i.workspace),
		pending,
	};
};

type Search = {
	connected?: string;
	linked?: string;
	error?: string;
	/** A private link the app sent, opened here: linked only once the User confirms it, since a mail's link scanner opens it first. */
	link?: string;
};

export const Route = createFileRoute("/_app/connections")({
	// where the authorization popup lands, from the api's callback
	validateSearch: (search): Search => ({
		...(typeof search.connected === "string" && {
			connected: search.connected,
		}),
		...(typeof search.linked === "string" && { linked: search.linked }),
		...(typeof search.error === "string" && { error: search.error }),
		...(typeof search.link === "string" && { link: search.link }),
	}),
	loaderDeps: ({ search }) => ({ link: search.link }),
	loader: ({ deps }) => getConnections(deps.link),
	component: ConnectionsPage,
});

/** The popup's message to the Connections page that opened it. */
const MESSAGE = "orqestra-connection";

const callbackErrors: Record<string, () => string> = {
	state_invalid: () => m.connections_state_invalid(),
	issuer_mismatch: () => m.connections_issuer_mismatch(),
	denied: () => m.connections_denied(),
	failed: () => m.connections_failed(),
};
const callbackText = (error: string) =>
	(callbackErrors[error] ?? callbackErrors.failed)();

/** An Integration's key in `busy`, apart from any MCP Server's id. */
const integrationKey = (kind: string) => `\0${kind}`;
const kindOf = (key: string) =>
	key.startsWith("\0") ? key.slice(1) : undefined;

/**
 * 「连接」: every per-User OAuth MCP Server, with the signed-in User's own Connection to it; and their account in each Integration
 * whose app is installed, linked by authorizing as themselves or by a link the app sends them, which is confirmed here.
 */
function ConnectionsPage() {
	const { rows, integrations, pending } = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const router = useRouter();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");

	const [linking, setLinking] = useState(false);
	const [linkedTo, setLinkedTo] = useState("");

	async function confirmLink(link: string, integration: string) {
		setLinking(true);
		try {
			await ok(api().api.integrations.link.post({ link }));
			setError("");
			setLinkedTo(integration);
			await navigate({ search: {}, replace: true });
		} catch (e) {
			setError(errorText(e));
		} finally {
			setLinking(false);
		}
	}

	useEffect(() => {
		if (!search.connected && !search.linked && !search.error) return;
		// in the popup: tell the page that opened it, and go
		if (window.opener && window.opener !== window) {
			window.opener.postMessage(
				{ type: MESSAGE, error: search.error },
				location.origin,
			);
			window.close();
			return;
		}
		// no popup (it was blocked, so this tab went): say how it went here
		setError(search.error ? callbackText(search.error) : "");
		void navigate({ search: {}, replace: true });
	}, [search, navigate]);

	useEffect(() => {
		const heard = (e: MessageEvent) => {
			if (e.origin !== location.origin || e.data?.type !== MESSAGE) return;
			setError(e.data.error ? callbackText(e.data.error) : "");
			void router.invalidate();
		};
		// a popup whose opener the authorization server cut off (COOP) cannot tell us: look again when the User is back
		const back = () => void router.invalidate();
		window.addEventListener("message", heard);
		window.addEventListener("focus", back);
		return () => {
			window.removeEventListener("message", heard);
			window.removeEventListener("focus", back);
		};
	}, [router]);

	async function connect(serverId: string) {
		// opened before the request, while the click still allows a popup
		const popup = window.open("", MESSAGE, "popup,width=600,height=720");
		setBusy(serverId);
		try {
			const kind = kindOf(serverId);
			const { url } = kind
				? await ok(api().api({ kind }).account.post())
				: await ok(api().api.connections({ serverId }).post());
			setError("");
			if (popup) popup.location.href = url;
			else location.href = url;
		} catch (e) {
			popup?.close();
			setError(errorText(e));
		} finally {
			setBusy(undefined);
		}
	}

	async function disconnect(serverId: string) {
		setBusy(serverId);
		try {
			const kind = kindOf(serverId);
			if (kind) await ok(api().api({ kind }).account.delete());
			else await ok(api().api.connections({ serverId }).delete());
			setError("");
			await router.invalidate();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(undefined);
		}
	}

	const date = (d: Date | string) =>
		new Date(d).toLocaleDateString(getLocale());
	const list = (names: string[]) =>
		new Intl.ListFormat(getLocale(), { type: "conjunction" }).format(names);

	return (
		<div className="flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-10">
			<ConsolePage
				title={m.connections_page()}
				description={m.connections_page_hint()}
			>
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				{linkedTo && (
					<Alert>
						<CheckCircle2Icon />
						<AlertDescription>
							{m.connections_link_done({ integration: linkedTo })}
						</AlertDescription>
					</Alert>
				)}
				{search.link &&
					pending &&
					("invalid" in pending ? (
						<Alert variant="destructive">
							<TriangleAlertIcon />
							<AlertDescription>{m.link_invalid()}</AlertDescription>
						</Alert>
					) : (
						<Alert>
							<LinkIcon />
							<AlertDescription className="flex flex-col gap-3">
								{m.connections_link_confirm({
									integration: pending.integration,
									name: pending.name,
								})}
								<span className="flex gap-2">
									<Button
										size="sm"
										disabled={linking}
										onClick={() =>
											void confirmLink(search.link ?? "", pending.integration)
										}
									>
										{m.connections_link_button()}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										disabled={linking}
										onClick={() => void navigate({ search: {}, replace: true })}
									>
										{m.cancel()}
									</Button>
								</span>
							</AlertDescription>
						</Alert>
					))}
				<ItemList
					empty={{
						icon: PlugIcon,
						title: m.connections_empty(),
						hint: m.connections_empty_hint(),
					}}
				>
					{integrations.map((i) => (
						<Item
							key={integrationKey(i.kind)}
							title={
								<>
									{i.name}
									{i.account ? (
										<Badge variant="outline">
											<CheckCircle2Icon />
											{m.connection_connected()}
										</Badge>
									) : (
										<Badge variant="secondary">
											<CircleDashedIcon />
											{m.connection_none()}
										</Badge>
									)}
								</>
							}
							description={
								i.account
									? m.connections_integration_as({ name: i.account.name }) +
										m.connections_since({
											date: date(i.account.createdAt),
										})
									: i.proof === "private-link"
										? m.connections_private_link_hint({
												workspace: i.workspace ?? i.name,
											})
										: m.connections_integration_hint({ name: i.name })
							}
							actions={
								i.account ? (
									<Button
										size="sm"
										variant="ghost"
										disabled={!!busy}
										onClick={() => {
											if (
												confirm(
													m.connections_integration_unlink_confirm({
														name: i.name,
													}),
												)
											)
												void disconnect(integrationKey(i.kind));
										}}
									>
										{m.connections_disconnect()}
									</Button>
								) : (
									i.proof === "oauth" && (
										<Button
											size="sm"
											disabled={!!busy}
											onClick={() => void connect(integrationKey(i.kind))}
										>
											<ExternalLinkIcon data-icon="inline-start" />
											{m.connections_connect()}
										</Button>
									)
								)
							}
						/>
					))}
					{rows.map((r) => (
						<Item
							key={r.id}
							title={
								<>
									{r.name}
									{r.status === "connected" && (
										<Badge variant="outline">
											<CheckCircle2Icon />
											{m.connection_connected()}
										</Badge>
									)}
									{r.status === "needs_reconnect" && (
										<Badge variant="destructive">
											<TriangleAlertIcon />
											{m.connection_needs_reconnect()}
										</Badge>
									)}
									{r.status === "none" && (
										<Badge variant="secondary">
											<CircleDashedIcon />
											{m.connection_none()}
										</Badge>
									)}
									{r.disabled && (
										<Badge variant="outline">{m.connections_disabled()}</Badge>
									)}
								</>
							}
							description={
								<>
									{!!r.agents.length &&
										m.connections_used_by({ agents: list(r.agents) })}
									{r.status === "connected" &&
										r.connectedAt &&
										m.connections_since({ date: date(r.connectedAt) })}
								</>
							}
							actions={
								<>
									{r.status !== "none" && (
										<Button
											size="sm"
											variant="ghost"
											disabled={!!busy}
											onClick={() => {
												if (
													confirm(
														m.connections_disconnect_confirm({
															server: r.name,
														}),
													)
												)
													void disconnect(r.id);
											}}
										>
											{m.connections_disconnect()}
										</Button>
									)}
									{r.status !== "connected" && !r.disabled && (
										<Button
											size="sm"
											disabled={!!busy}
											onClick={() => void connect(r.id)}
										>
											<ExternalLinkIcon data-icon="inline-start" />
											{r.status === "needs_reconnect"
												? m.connections_reconnect()
												: m.connections_connect()}
										</Button>
									)}
								</>
							}
						>
							{r.status === "needs_reconnect" && (
								<p className="text-xs text-muted-foreground">
									{m.connections_reconnect_hint({ server: r.name })}
								</p>
							)}
							{r.disabled && (
								<p className="text-xs text-muted-foreground">
									{m.connections_disabled_hint({ server: r.name })}
								</p>
							)}
						</Item>
					))}
				</ItemList>
			</ConsolePage>
		</div>
	);
}
