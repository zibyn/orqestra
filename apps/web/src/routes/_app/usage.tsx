import { createFileRoute } from "@tanstack/react-router";
import { ConsolePage } from "#/components/ConsolePage";
import { UsageReport } from "#/components/UsageReport";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/_app/usage")({
	component: UsagePage,
});

/** The signed-in User's own Usage over a range, by Agent or by Model; read-only. */
function UsagePage() {
	return (
		<div className="flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-10">
			<ConsolePage title={m.usage_page()} description={m.usage_page_hint()}>
				<UsageReport mine />
			</ConsolePage>
		</div>
	);
}
