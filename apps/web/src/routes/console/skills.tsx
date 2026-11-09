import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Loader2Icon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { ConsolePage } from "#/components/ConsolePage";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { FieldError } from "#/components/ui/field";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { errorText, firstError } from "#/lib/save-errors";
import {
	deleteSkill,
	getSkills,
	setSkillEnabled,
	setSkillVersion,
	uploadSkill,
} from "#/lib/skills";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

export const Route = createFileRoute("/console/skills")({
	loader: () => getSkills(),
	component: Skills,
});

/** Skills uploaded as zips, each with its versions. */
function Skills() {
	const skills = Route.useLoaderData();
	const router = useRouter();
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState("");

	async function act(key: string, action: () => Promise<unknown>) {
		setBusy(key);
		try {
			await action();
			setError("");
			await router.invalidate();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(undefined);
		}
	}

	async function upload(file: File) {
		const send = (replace: boolean) => {
			const data = new FormData();
			data.set("file", file);
			data.set("replace", String(replace));
			return uploadSkill({ data });
		};
		let result = await send(false);
		if (
			result.errors.name?.code === "skill_exists" &&
			confirm(m.skill_exists_confirm({ name: result.name ?? "" }))
		)
			result = await send(true);
		else if (result.errors.name) return;
		const failed = firstError(result);
		if (failed) throw new Error(failed);
	}

	return (
		<ConsolePage
			title={m.skills()}
			description={m.skills_hint()}
			action={
				<>
					<input
						ref={input}
						type="file"
						accept=".zip,application/zip"
						className="hidden"
						aria-label={m.upload_skill()}
						onChange={(e) => {
							const file = e.target.files?.[0];
							e.target.value = "";
							if (file) void act("upload", () => upload(file));
						}}
					/>
					<Button disabled={!!busy} onClick={() => input.current?.click()}>
						{busy === "upload" ? (
							<Loader2Icon data-icon="inline-start" className="animate-spin" />
						) : (
							<UploadIcon data-icon="inline-start" />
						)}
						{m.upload_skill()}
					</Button>
				</>
			}
		>
			<FieldError>{error}</FieldError>
			{!skills.length && (
				<p className="text-sm text-muted-foreground">{m.no_skills()}</p>
			)}
			{skills.map((s) => (
				<Card key={s.name}>
					<CardHeader>
						<CardTitle className="font-mono">{s.name}</CardTitle>
						<CardDescription>{s.description}</CardDescription>
						<CardAction className="flex items-center gap-4">
							<div className="flex items-center gap-2">
								<Switch
									id={`skill-${s.name}-enabled`}
									checked={s.enabled}
									disabled={!!busy}
									onCheckedChange={(enabled) =>
										act(`enable-${s.name}`, () =>
											setSkillEnabled({ data: { name: s.name, enabled } }),
										)
									}
								/>
								<Label htmlFor={`skill-${s.name}-enabled`}>
									{m.skill_enabled()}
								</Label>
							</div>
							<Button
								size="sm"
								variant="destructive"
								disabled={!!busy}
								onClick={() => {
									if (confirm(m.delete_skill_confirm()))
										void act(`delete-${s.name}`, () =>
											deleteSkill({ data: s.name }),
										);
								}}
							>
								{busy === `delete-${s.name}` && (
									<Loader2Icon
										data-icon="inline-start"
										className="animate-spin"
									/>
								)}
								{m.delete()}
							</Button>
						</CardAction>
					</CardHeader>
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{m.skill_version()}</TableHead>
									<TableHead>{m.skill_uploaded_at()}</TableHead>
									<TableHead>{m.skill_description()}</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{s.versions.map((v) => (
									<TableRow key={v.id}>
										<TableCell className="font-mono">v{v.number}</TableCell>
										<TableCell>
											{new Date(v.createdAt).toLocaleString(getLocale())}
										</TableCell>
										<TableCell className="max-w-md truncate">
											{v.description}
										</TableCell>
										<TableCell className="text-right">
											{v.id === s.currentVersionId ? (
												<Badge variant="secondary">
													{m.skill_current_version()}
												</Badge>
											) : (
												<Button
													size="sm"
													variant="outline"
													disabled={!!busy}
													onClick={() => {
														if (
															confirm(
																m.skill_rollback_confirm({ number: v.number }),
															)
														)
															void act(`version-${v.id}`, () =>
																setSkillVersion({
																	data: { name: s.name, versionId: v.id },
																}),
															);
													}}
												>
													{busy === `version-${v.id}` && (
														<Loader2Icon
															data-icon="inline-start"
															className="animate-spin"
														/>
													)}
													{m.skill_rollback()}
												</Button>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			))}
		</ConsolePage>
	);
}
