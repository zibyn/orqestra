import { useQuery } from "@tanstack/react-query";
import { BellIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { DropdownMenuCheckboxItem } from "#/components/ui/dropdown-menu";
import { api, ok } from "#/lib/api";
import { m } from "#/paraglide/messages";

const subscriptions = () => api().api.push.subscriptions;
/** This browser's push subscription, if it has one. */
const current = async () =>
	(
		await navigator.serviceWorker.getRegistration()
	)?.pushManager.getSubscription();

/**
 * "Receive Alerts in this browser", for a DropdownMenu; only mounted on the client when the menu opens.
 * Absent while the instance has no VAPID keys or the browser has no Web Push.
 */
export function AlertSwitch() {
	const { data } = useQuery({
		queryKey: ["push"],
		queryFn: () => ok(api().api.push.get()),
	});
	const [on, setOn] = useState(false);
	const [busy, setBusy] = useState(false);
	const supported = "serviceWorker" in navigator && "PushManager" in window;
	useEffect(() => {
		if (supported) void current().then((s) => setOn(!!s));
	}, [supported]);
	if (!supported || !data?.publicKey) return null;
	const publicKey = data.publicKey;

	async function toggle(enable: boolean) {
		setBusy(true);
		try {
			if (enable) {
				const registration = await navigator.serviceWorker.register("/sw.js");
				await navigator.serviceWorker.ready;
				// asks for the permission to notify; throws when refused
				const sub = await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: publicKey,
				});
				const { endpoint, keys } = sub.toJSON();
				await ok(
					subscriptions().put({
						endpoint: endpoint as string,
						keys: keys as { p256dh: string; auth: string },
					}),
				);
			} else {
				const sub = await current();
				if (sub) {
					await ok(subscriptions().delete({ endpoint: sub.endpoint }));
					await sub.unsubscribe();
				}
			}
			setOn(enable);
		} catch (error) {
			console.error("could not change this browser's Alerts", error);
		} finally {
			setBusy(false);
		}
	}

	return (
		<DropdownMenuCheckboxItem
			checked={on}
			disabled={busy || Notification.permission === "denied"}
			onCheckedChange={(v) => void toggle(v)}
			closeOnClick={false}
		>
			<BellIcon />
			{m.alerts_browser()}
		</DropdownMenuCheckboxItem>
	);
}
