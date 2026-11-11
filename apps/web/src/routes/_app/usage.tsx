import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Input } from "#/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import { api, ok } from "#/lib/api";
import { errorText } from "#/lib/save-errors";
import { type UsagePreset, usageRange } from "#/lib/usage";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export const Route = createFileRoute("/_app/usage")({
	component: UsagePage,
});

type Group = "agent" | "model";
const getUsage = (query: { from: string; to: string; group: Group }) =>
	ok(api().api.usage.mine.get({ query }));
type Row = Awaited<ReturnType<typeof getUsage>>["rows"][number];

const presets: Record<UsagePreset | "custom", () => string> = {
	today: m.usage_today,
	"7d": m.usage_7d,
	"30d": m.usage_30d,
	month: m.usage_month,
	custom: m.usage_custom,
};

/** The signed-in User's own Usage over a range, by Agent or by Model; read-only. */
function UsagePage() {
	const [preset, setPreset] = useState<UsagePreset | "custom">("month");
	const [custom, setCustom] = useState({ from: "", to: "" });
	const [group, setGroup] = useState<Group>("agent");
	const [rows, setRows] = useState<Row[]>();
	const [error, setError] = useState("");

	// fetched in the browser, whose time zone draws the days
	useEffect(() => {
		if (preset === "custom" && !(custom.from && custom.to)) return;
		let current = true;
		getUsage({
			...usageRange(preset === "custom" ? custom : preset),
			group,
		}).then(
			(r) => {
				if (!current) return;
				setRows(r.rows);
				setError("");
			},
			(e) => current && setError(errorText(e)),
		);
		return () => {
			current = false;
		};
	}, [preset, custom, group]);

	const locale = getLocale();
	const number = (n: number) => n.toLocaleString(locale);
	const usd = (n: number) =>
		n.toLocaleString(locale, {
			style: "currency",
			currency: "USD",
			maximumFractionDigits: 4,
		});

	return (
		<div className="flex-1 overflow-y-auto px-4 py-6 md:px-10 md:py-10">
			<ConsolePage title={m.usage_page()} description={m.usage_page_hint()}>
				<div className="flex flex-wrap items-center gap-3">
					<ToggleGroup
						variant="outline"
						spacing={0}
						value={[preset]}
						onValueChange={([p]) => p && setPreset(p as typeof preset)}
					>
						{(Object.keys(presets) as (keyof typeof presets)[]).map((p) => (
							<ToggleGroupItem key={p} value={p}>
								{presets[p]()}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
					{preset === "custom" && (
						<div className="flex items-center gap-2">
							<Input
								type="date"
								aria-label={m.usage_from()}
								value={custom.from}
								onChange={(e) => setCustom({ ...custom, from: e.target.value })}
							/>
							<span>–</span>
							<Input
								type="date"
								aria-label={m.usage_to()}
								value={custom.to}
								onChange={(e) => setCustom({ ...custom, to: e.target.value })}
							/>
						</div>
					)}
					<ToggleGroup
						variant="outline"
						spacing={0}
						className="ms-auto"
						value={[group]}
						onValueChange={([g]) => g && setGroup(g as Group)}
					>
						<ToggleGroupItem value="agent">
							{m.usage_by_agent()}
						</ToggleGroupItem>
						<ToggleGroupItem value="model">
							{m.usage_by_model()}
						</ToggleGroupItem>
					</ToggleGroup>
				</div>
				{error && (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				)}
				<div className="overflow-x-auto rounded-xl border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>
									{group === "agent" ? m.usage_agent() : m.usage_model()}
								</TableHead>
								<TableHead className="text-right">
									{m.usage_requests()}
								</TableHead>
								<TableHead className="text-right">{m.usage_input()}</TableHead>
								<TableHead className="text-right">{m.usage_output()}</TableHead>
								<TableHead className="text-right">
									{m.usage_cache_read()}
								</TableHead>
								<TableHead className="text-right">
									{m.usage_cache_write()}
								</TableHead>
								<TableHead className="text-right">{m.usage_cost()}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows?.length === 0 && (
								<TableRow>
									<TableCell
										colSpan={7}
										className="text-center text-muted-foreground"
									>
										{m.usage_none()}
									</TableCell>
								</TableRow>
							)}
							{rows?.map((r) => (
								<TableRow key={r.key ?? ""}>
									<TableCell className="font-medium">
										{r.name ?? m.usage_general_worker()}
										{"deleted" in r && r.deleted && (
											<Badge variant="outline" className="ms-2">
												{m.usage_deleted()}
											</Badge>
										)}
										{"disabled" in r && r.disabled && (
											<Badge variant="outline" className="ms-2">
												{m.usage_disabled()}
											</Badge>
										)}
									</TableCell>
									<TableCell className="text-right">
										{number(r.requests)}
									</TableCell>
									<TableCell className="text-right">
										{number(r.inputTokens)}
									</TableCell>
									<TableCell className="text-right">
										{number(r.outputTokens)}
									</TableCell>
									<TableCell className="text-right">
										{number(r.cacheReadTokens)}
									</TableCell>
									<TableCell className="text-right">
										{number(r.cacheWriteTokens)}
									</TableCell>
									<TableCell className="text-right">{usd(r.cost)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</ConsolePage>
		</div>
	);
}
