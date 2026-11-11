import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
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
import { resetDate, type UsagePreset, usageRange } from "#/lib/usage";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export type UsageGroup = "user" | "agent" | "model";
/** Drill-down filters: a User's id, an Agent's id ("" the general worker), a Model's `provider/id`. */
type Filters = Partial<Record<UsageGroup, string>>;
type Query = { from: string; to: string; group: UsageGroup } & Filters;
const getAll = (query: Query) => ok(api().api.usage.get({ query }));
type Row = Awaited<ReturnType<typeof getAll>>["rows"][number];
// My Usage never groups by User
const fetchMine = (query: Query) =>
	ok(
		api().api.usage.mine.get({
			query: query as Query & { group: "agent" | "model" },
		}),
	);
type SpendingStatus = Awaited<ReturnType<typeof fetchMine>>["status"];
const getMine = fetchMine as (
	query: Query,
) => Promise<{ rows: Row[]; status?: SpendingStatus }>;

const presets: Record<UsagePreset | "custom", () => string> = {
	today: m.usage_today,
	"7d": m.usage_7d,
	"30d": m.usage_30d,
	month: m.usage_month,
	custom: m.usage_custom,
};
const groupLabels: Record<UsageGroup, () => string> = {
	user: m.usage_by_user,
	agent: m.usage_by_agent,
	model: m.usage_by_model,
};
const columnLabels: Record<UsageGroup, () => string> = {
	user: m.usage_user,
	agent: m.usage_agent,
	model: m.usage_model,
};

/**
 * Usage over a range: the signed-in User's own (mine), by Agent or Model, read-only; or every
 * User's, by User, Agent or Model, where clicking a row filters by it and groups by a
 * dimension not yet filtered.
 */
export function UsageReport({ mine = false }: { mine?: boolean }) {
	const groups: UsageGroup[] = mine
		? ["agent", "model"]
		: ["user", "agent", "model"];
	const fetch = mine ? getMine : getAll;
	const drill = !mine;
	const [preset, setPreset] = useState<UsagePreset | "custom">("month");
	const [custom, setCustom] = useState({ from: "", to: "" });
	const [group, setGroup] = useState<UsageGroup>(groups[0]);
	// each filter with the name of the row it came from
	const [filters, setFilters] = useState<
		{ group: UsageGroup; key: string; name: string }[]
	>([]);
	const [rows, setRows] = useState<Row[]>();
	// My Usage only, and only with a Spending Limit
	const [status, setStatus] = useState<SpendingStatus>(null);
	const [error, setError] = useState("");

	// fetched in the browser, whose time zone draws the days
	useEffect(() => {
		if (preset === "custom" && !(custom.from && custom.to)) return;
		let current = true;
		fetch({
			...usageRange(preset === "custom" ? custom : preset),
			group,
			...Object.fromEntries(filters.map((f) => [f.group, f.key])),
		}).then(
			(r) => {
				if (!current) return;
				setRows(r.rows);
				setStatus(("status" in r && r.status) || null);
				setError("");
			},
			(e) => current && setError(errorText(e)),
		);
		return () => {
			current = false;
		};
	}, [preset, custom, group, filters, fetch]);

	const open = groups.filter(
		(g) => g !== group && !filters.some((f) => f.group === g),
	);
	const drillInto = (r: Row) => {
		if (!drill || open.length === 0) return;
		setFilters([
			...filters,
			{ group, key: r.key ?? "", name: r.name ?? m.usage_general_worker() },
		]);
		setGroup(open[0]);
	};
	const unfilter = (g: UsageGroup) => {
		setFilters(filters.filter((f) => f.group !== g));
		setGroup(g);
	};

	const locale = getLocale();
	const number = (n: number) => n.toLocaleString(locale);
	const usd = (n: number) =>
		n.toLocaleString(locale, {
			style: "currency",
			currency: "USD",
			maximumFractionDigits: 4,
		});

	return (
		<>
			{status && (
				<Alert variant={status.reached ? "destructive" : "default"}>
					<AlertDescription>
						{m.usage_spending_status({
							spent: usd(status.spent),
							usd: usd(status.usd),
							date: resetDate(status, locale),
						})}
					</AlertDescription>
				</Alert>
			)}
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
					onValueChange={([g]) => g && setGroup(g as UsageGroup)}
				>
					{groups
						.filter((g) => !filters.some((f) => f.group === g))
						.map((g) => (
							<ToggleGroupItem key={g} value={g}>
								{groupLabels[g]()}
							</ToggleGroupItem>
						))}
				</ToggleGroup>
			</div>
			{filters.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					{filters.map((f) => (
						<Badge key={f.group} variant="secondary" className="gap-1 pe-0.5">
							{columnLabels[f.group]()}: {f.name}
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={m.usage_remove_filter()}
								onClick={() => unfilter(f.group)}
							>
								<XIcon />
							</Button>
						</Badge>
					))}
				</div>
			)}
			{error && (
				<Alert variant="destructive">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			<div className="overflow-x-auto rounded-xl border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{columnLabels[group]()}</TableHead>
							<TableHead className="text-right">{m.usage_requests()}</TableHead>
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
						{rows?.map((r) => {
							const drillable = drill && open.length > 0;
							return (
								<TableRow
									key={r.key ?? ""}
									className={drillable ? "cursor-pointer" : undefined}
									tabIndex={drillable ? 0 : undefined}
									onClick={() => drillInto(r)}
									onKeyDown={(e) => e.key === "Enter" && drillInto(r)}
								>
									<TableCell className="font-medium">
										{group === "user" ? (
											<Link
												to="/console/users"
												className="hover:underline"
												onClick={(e) => e.stopPropagation()}
											>
												{r.name}
											</Link>
										) : (
											(r.name ?? m.usage_general_worker())
										)}
										{"deleted" in r && r.deleted === true && (
											<Badge variant="outline" className="ms-2">
												{m.usage_deleted()}
											</Badge>
										)}
										{"disabled" in r && r.disabled === true && (
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
							);
						})}
					</TableBody>
				</Table>
			</div>
		</>
	);
}
