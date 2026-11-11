import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	CheckCircle2Icon,
	CircleDashedIcon,
	ExternalLinkIcon,
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

const getConnections = () => ok(api().api.connections.get());

type Search = { connected?: string; error?: string };

export const Route = createFileRoute("/_app/connections")({
	// where the authorization popup lands, from the api's callback
	validateSearch: (search): Search => ({
		...(typeof search.connected === "string" && {
			connected: search.connected,
		}),
		...(typeof search.error === "string" && { error: search.error }),
	}),
	loader: getConnections,
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

/** 「连接」: every per-User OAuth MCP Server, with the signed-in User's own Connection to it. */
function ConnectionsPage() {
	const rows = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = Route.useNavigate();
	const router = useRouter();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");

	useEffect(() => {
		if (!search.connected && !search.error) return;
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
			const { url } = await ok(api().api.connections({ serverId }).post());
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
				<ItemList
					empty={{
						icon: PlugIcon,
						title: m.connections_empty(),
						hint: m.connections_empty_hint(),
					}}
				>
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
								// shortcut: no Disconnect yet, it comes with disconnecting (#120)
								r.status !== "connected" &&
								!r.disabled && (
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
								)
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
