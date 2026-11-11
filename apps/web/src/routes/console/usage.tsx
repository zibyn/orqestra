import { createFileRoute } from "@tanstack/react-router";
import { ConsolePage } from "#/components/ConsolePage";
import { UsageReport } from "#/components/UsageReport";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/console/usage")({
	component: ConsoleUsagePage,
});

/** Every User's Usage over a range, by User, Agent or Model, drilling down by clicking a row. */
function ConsoleUsagePage() {
	return (
		<ConsolePage title={m.console_usage()} description={m.console_usage_hint()}>
			<UsageReport />
		</ConsolePage>
	);
}
