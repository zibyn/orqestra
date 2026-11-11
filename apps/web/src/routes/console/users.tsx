import type { UserSpendingLimit } from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Button } from "#/components/ui/button";
import { FieldError } from "#/components/ui/field";
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
import { errorText, saved, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export const Route = createFileRoute("/console/users")({
	loader: async () => (await ok(api().api.users.get())).users,
	component: UsersPage,
});

const settingText = (s: UserSpendingLimit) =>
	s.mode === "default"
		? m.user_spending_default()
		: s.mode === "unlimited"
			? m.user_spending_unlimited()
			: m.user_spending_limited({ usd: s.usd.toLocaleString(getLocale()) });

/** The Users who have used Orqestra; the Admin viewing is one of them, so the list is never empty. */
function UsersPage() {
	const users = Route.useLoaderData();
	const [editing, setEditing] = useState<string>();
	const locale = getLocale();
	return (
		<ConsolePage title={m.users()} description={m.users_hint()}>
			<div className="rounded-xl border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{m.user_name()}</TableHead>
							<TableHead>{m.user_email()}</TableHead>
							<TableHead>{m.user_last_active()}</TableHead>
							<TableHead className="text-right">{m.user_spent()}</TableHead>
							<TableHead>{m.user_spending_limit()}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{users.map((u) => (
							<TableRow key={u.id}>
								<TableCell className="font-medium">{u.name}</TableCell>
								<TableCell className="text-muted-foreground">
									{u.email ?? "—"}
								</TableCell>
								<TableCell>
									{new Date(u.lastActiveAt).toLocaleString(locale)}
								</TableCell>
								<TableCell className="text-right">
									{u.spent.toLocaleString(locale, {
										style: "currency",
										currency: "USD",
										maximumFractionDigits: 4,
									})}
								</TableCell>
								<TableCell>
									{editing === u.id ? (
										<SpendingLimitEditor
											userId={u.id}
											stored={u.spendingLimit}
											onDone={() => setEditing(undefined)}
										/>
									) : (
										<div className="flex items-center gap-2">
											{settingText(u.spendingLimit)}
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setEditing(u.id)}
											>
												{m.edit()}
											</Button>
										</div>
									)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</ConsolePage>
	);
}

/** A User's own Spending Limit: follow the default, unlimited, or so many dollars, the amount asked for only then. */
function SpendingLimitEditor({
	userId,
	stored,
	onDone,
}: {
	userId: string;
	stored: UserSpendingLimit;
	onDone: () => void;
}) {
	const router = useRouter();
	const [mode, setMode] = useState(stored.mode);
	const [usd, setUsd] = useState(
		stored.mode === "limited" ? String(stored.usd) : "",
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function save() {
		setBusy(true);
		try {
			// an empty amount goes as none, for the api to refuse rather than read as $0
			const body = (
				mode === "limited"
					? { mode, usd: usd.trim() ? Number(usd) : undefined }
					: { mode }
			) as UserSpendingLimit;
			const result = await saved(
				api().api.users({ id: userId })["spending-limit"].put(body),
			);
			const errors = saveErrorTexts(result.errors);
			setError(Object.values(errors)[0] ?? "");
			if (!Object.keys(errors).length) {
				await router.invalidate();
				onDone();
			}
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<ToggleGroup
				aria-label={m.user_spending_limit()}
				variant="outline"
				spacing={0}
				value={[mode]}
				// a pressed mode stays pressed: there is always one
				onValueChange={([v]) => v && setMode(v as typeof mode)}
			>
				<ToggleGroupItem value="default">
					{m.user_spending_default()}
				</ToggleGroupItem>
				<ToggleGroupItem value="unlimited">
					{m.user_spending_unlimited()}
				</ToggleGroupItem>
				<ToggleGroupItem value="limited">
					{m.user_spending_limited_option()}
				</ToggleGroupItem>
			</ToggleGroup>
			{mode === "limited" && (
				<Input
					type="number"
					aria-label={m.limit_spending_usd()}
					placeholder={m.limit_spending_usd()}
					required
					min={0}
					step="any"
					aria-invalid={!!error || undefined}
					value={usd}
					onChange={(e) => setUsd(e.target.value)}
				/>
			)}
			<FieldError>{error}</FieldError>
			<div className="flex gap-2">
				<Button type="submit" size="sm" disabled={busy}>
					{busy && (
						<Loader2Icon data-icon="inline-start" className="animate-spin" />
					)}
					{m.save()}
				</Button>
				<Button type="button" variant="ghost" size="sm" onClick={onDone}>
					{m.cancel()}
				</Button>
			</div>
		</form>
	);
}
