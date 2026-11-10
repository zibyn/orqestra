import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { api, ok } from "#/lib/api";
import { errorText, saved, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";

const load = async () => (await ok(api().api.limits.get())).limits;

export const Route = createFileRoute("/console/limits")({
	loader: load,
	component: LimitsPage,
});

type Limits = Awaited<ReturnType<typeof load>>;

// durations are stored in seconds and edited in minutes
const fields: {
	key: keyof Limits;
	label: () => string;
	minutes?: boolean;
	max?: number;
}[] = [
	{
		key: "maxScheduledTasksPerUser",
		label: m.limit_max_scheduled_tasks_per_user,
	},
	{
		key: "minFiringInterval",
		label: m.limit_min_firing_interval,
		minutes: true,
	},
	{
		key: "timerRingsPerUserMessage",
		label: m.limit_timer_rings_per_user_message,
	},
	{ key: "unattendedMaxSteps", label: m.limit_unattended_max_steps },
	{
		key: "unattendedMaxDuration",
		label: m.limit_unattended_max_duration,
		minutes: true,
	},
	{ key: "maxSubagentDepth", label: m.limit_max_subagent_depth, max: 3 },
];

/** The instance's Limits, read by the next Run. */
function LimitsPage() {
	const stored = Route.useLoaderData();
	const router = useRouter();
	const [values, setValues] = useState(() =>
		Object.fromEntries(
			fields.map((f) => [
				f.key,
				String(f.minutes ? stored[f.key] / 60 : stored[f.key]),
			]),
		),
	);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});

	async function save() {
		setBusy(true);
		setDone(false);
		try {
			const limits = Object.fromEntries(
				fields.map((f) => [
					f.key,
					Math.round(Number(values[f.key]) * (f.minutes ? 60 : 1)),
				]),
			) as unknown as Limits;
			const result = await saved(api().api.limits.put(limits));
			setErrors(saveErrorTexts(result.errors));
			setDone(!Object.keys(result.errors).length);
			await router.invalidate();
		} catch (e) {
			setErrors({ "": errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<ConsolePage title={m.limits()} description={m.limits_hint()}>
			<Card>
				<CardContent>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void save();
						}}
					>
						<FieldGroup className="gap-5">
							<div className="grid gap-5 md:grid-cols-2">
								{fields.map((f) => (
									<Field
										key={f.key}
										data-invalid={!!errors[f.key] || undefined}
									>
										<FieldLabel htmlFor={`limit-${f.key}`}>
											{f.label()}
										</FieldLabel>
										<Input
											id={`limit-${f.key}`}
											type="number"
											required
											min={1}
											max={f.max}
											step={1}
											aria-invalid={!!errors[f.key] || undefined}
											value={values[f.key]}
											onChange={(e) =>
												setValues({ ...values, [f.key]: e.target.value })
											}
										/>
										<FieldError>{errors[f.key]}</FieldError>
									</Field>
								))}
							</div>
							<Button type="submit" className="self-start" disabled={busy}>
								{busy && (
									<Loader2Icon
										data-icon="inline-start"
										className="animate-spin"
									/>
								)}
								{m.save()}
							</Button>
							{done && (
								<Alert>
									<CheckCircle2Icon />
									<AlertDescription>{m.limits_saved()}</AlertDescription>
								</Alert>
							)}
							<FieldError>{errors[""]}</FieldError>
						</FieldGroup>
					</form>
				</CardContent>
			</Card>
		</ConsolePage>
	);
}
