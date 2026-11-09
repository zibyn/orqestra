import type { SaveErrors } from "@orqestra/config/shared";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	BookOpenIcon,
	FileIcon,
	Loader2Icon,
	PlusIcon,
	Trash2Icon,
	UploadIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	ConsolePage,
	DeleteButton,
	FormSheet,
	Item,
	ItemList,
	SheetForm,
	useSheet,
} from "#/components/ConsolePage";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "#/components/ui/input-group";
import { SheetFooter } from "#/components/ui/sheet";
import { Switch } from "#/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "#/components/ui/table";
import { Textarea } from "#/components/ui/textarea";
import { api } from "#/lib/api";
import { errorText, firstError, saveErrorTexts } from "#/lib/save-errors";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

/** The data of an api call; throws what to show when it failed. */
function data<T>(result: { data: T; error: unknown }): NonNullable<T> {
	if (result.error) throw new Error(m.request_failed());
	return result.data as NonNullable<T>;
}

/** A save's field errors, empty once saved: the api answers 422 (or 413 for a zip) with them. */
function saved(result: { error: { status: unknown; value: unknown } | null }): {
	errors: SaveErrors;
	name?: string;
} {
	if (!result.error) return { errors: {} };
	if (result.error.status === 422 || result.error.status === 413)
		return result.error.value as { errors: SaveErrors; name?: string };
	throw new Error(m.request_failed());
}

const skillsApi = () => api().api.skills;

export const Route = createFileRoute("/console/skills")({
	loader: async () => data(await skillsApi().get()),
	component: Skills,
});

/** Skills uploaded as zips or written here, each with its versions. */
function Skills() {
	const skills = Route.useLoaderData();
	const router = useRouter();
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState<string>();
	const sheet = useSheet<
		{ kind: "new"; name?: never } | { kind: "files" | "versions"; name: string }
	>();
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
		// not through Eden, which would send the File as JSON
		const send = async (replace: boolean) => {
			const response = await fetch(`/api/skills?replace=${replace}`, {
				method: "POST",
				body: file,
			});
			return saved({
				error: response.ok
					? null
					: { status: response.status, value: await response.json() },
			});
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

	const shown = skills.find((s) => s.name === sheet.item?.name);

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
					<Button
						variant="outline"
						disabled={!!busy}
						onClick={() => input.current?.click()}
					>
						{busy === "upload" ? (
							<Loader2Icon data-icon="inline-start" className="animate-spin" />
						) : (
							<UploadIcon data-icon="inline-start" />
						)}
						{m.upload_skill()}
					</Button>
					<Button onClick={() => sheet.show({ kind: "new" })}>
						<PlusIcon data-icon="inline-start" />
						{m.new_skill()}
					</Button>
				</>
			}
		>
			<FieldError>{error}</FieldError>
			<ItemList
				empty={{
					icon: BookOpenIcon,
					title: m.no_skills_title(),
					hint: m.no_skills(),
				}}
			>
				{skills.map((s) => (
					<Item
						key={s.name}
						title={
							<>
								<span className="font-mono">{s.name}</span>
								<Badge variant="outline" className="font-mono">
									v{s.versions.find((v) => v.id === s.currentVersionId)?.number}
								</Badge>
							</>
						}
						description={s.description}
						actions={
							<>
								<Switch
									aria-label={m.skill_enabled()}
									checked={s.enabled}
									disabled={!!busy}
									onCheckedChange={(enabled) =>
										act(`enable-${s.name}`, () =>
											skillsApi()({ name: s.name })
												.enabled.put({ enabled })
												.then(data),
										)
									}
								/>
								<Button
									size="sm"
									variant="ghost"
									onClick={() => sheet.show({ kind: "versions", name: s.name })}
								>
									{m.skill_versions()}
								</Button>
								<Button
									size="sm"
									variant="outline"
									disabled={s.currentVersionId === null}
									onClick={() => sheet.show({ kind: "files", name: s.name })}
								>
									{m.edit_skill_files()}
								</Button>
								<DeleteButton
									busy={busy === `delete-${s.name}`}
									disabled={!!busy}
									onClick={() => {
										if (confirm(m.delete_skill_confirm()))
											void act(`delete-${s.name}`, () =>
												skillsApi()({ name: s.name }).delete().then(data),
											);
									}}
								/>
							</>
						}
					/>
				))}
			</ItemList>
			<FormSheet
				open={sheet.open}
				onClose={sheet.close}
				className={
					sheet.item?.kind === "new"
						? undefined
						: "data-[side=right]:sm:max-w-3xl"
				}
				title={
					sheet.item?.kind === "new" ? (
						m.new_skill()
					) : (
						<span className="font-mono">{sheet.item?.name}</span>
					)
				}
				description={
					sheet.item?.kind === "new"
						? m.new_skill_hint()
						: sheet.item?.kind === "versions"
							? m.skill_versions()
							: m.edit_skill_files()
				}
			>
				{sheet.item?.kind === "new" && <NewSkillForm onDone={sheet.close} />}
				{sheet.item?.kind === "files" && shown?.currentVersionId != null && (
					<SkillEditor
						name={shown.name}
						base={shown.currentVersionId}
						onClose={sheet.close}
					/>
				)}
				{sheet.item?.kind === "versions" && shown && (
					<div className="flex-1 overflow-y-auto p-4">
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
								{shown.versions.map((v) => (
									<TableRow key={v.id}>
										<TableCell className="font-mono">v{v.number}</TableCell>
										<TableCell>
											{new Date(v.createdAt).toLocaleString(getLocale())}
										</TableCell>
										<TableCell className="max-w-xs truncate">
											{v.description}
										</TableCell>
										<TableCell className="text-right">
											{v.id === shown.currentVersionId ? (
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
																skillsApi()({ name: shown.name })
																	.current.put({ versionId: v.id })
																	.then(data),
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
						<FieldError>{error}</FieldError>
					</div>
				)}
			</FormSheet>
		</ConsolePage>
	);
}

/** Creates a Skill whose SKILL.md holds only the name and description. */
function NewSkillForm({ onDone }: { onDone: () => void }) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});

	async function create() {
		setBusy(true);
		try {
			const result = saved(await skillsApi()({ name }).put({ description }));
			setErrors(saveErrorTexts(result.errors));
			if (!Object.keys(result.errors).length) {
				await router.invalidate();
				onDone();
			}
		} catch (e) {
			setErrors({ "": errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	return (
		<SheetForm
			onSubmit={() => void create()}
			busy={busy}
			submitLabel={m.create_skill()}
		>
			<FieldGroup className="gap-5">
				<Field data-invalid={!!errors.name || undefined}>
					<FieldLabel htmlFor="new-skill-name">{m.skill_name()}</FieldLabel>
					<Input
						id="new-skill-name"
						className="font-mono"
						value={name}
						onChange={(e) => setName(e.target.value)}
						aria-invalid={!!errors.name || undefined}
						required
					/>
					<FieldError>{errors.name}</FieldError>
				</Field>
				<Field data-invalid={!!errors.description || undefined}>
					<FieldLabel htmlFor="new-skill-description">
						{m.skill_description()}
					</FieldLabel>
					<Textarea
						id="new-skill-description"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						aria-invalid={!!errors.description || undefined}
						required
					/>
					<FieldError>{errors.description}</FieldError>
				</Field>
				<FieldError>{errors[""]}</FieldError>
			</FieldGroup>
		</SheetForm>
	);
}

type EditedFile = { path: string; size: number; text?: string };

/** Edits the files of version `base`: text files are written here, binary ones can only be dropped. Saving makes a new version. */
function SkillEditor({
	name,
	base,
	onClose,
}: {
	name: string;
	base: number;
	onClose: () => void;
}) {
	const router = useRouter();
	const [files, setFiles] = useState<EditedFile[]>();
	const [open, setOpen] = useState("SKILL.md");
	const [newPath, setNewPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		skillsApi()
			.versions({ id: base })
			.files.get()
			.then(data)
			.then(setFiles, (e) => setError(errorText(e)));
	}, [base]);

	const file = files?.find((f) => f.path === open);

	function add() {
		const path = newPath.trim();
		if (!path || !files) return;
		if (files.some((f) => f.path === path))
			return setError(m.skill_file_exists({ path }));
		setFiles([...files, { path, size: 0, text: "" }]);
		setOpen(path);
		setNewPath("");
		setError("");
	}

	async function save() {
		if (!files) return;
		setBusy(true);
		try {
			const result = saved(
				await skillsApi()({ name }).versions.post({
					base,
					files: files.map(({ path, text }) => ({ path, text })),
				}),
			);
			const failed = firstError(result);
			if (failed) return setError(failed);
			onClose();
			await router.invalidate();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}

	if (!files)
		return (
			<div className="p-4">
				{error ? (
					<FieldError>{error}</FieldError>
				) : (
					<Loader2Icon className="animate-spin text-muted-foreground" />
				)}
			</div>
		);
	return (
		<>
			{/* a container, so the panes sit side by side by the sheet's width, not the screen's */}
			<div className="@container flex min-h-0 flex-1 flex-col gap-3 p-4">
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border @xl:flex-row">
					<div className="flex max-h-48 shrink-0 flex-col border-b @xl:max-h-none @xl:w-60 @xl:border-r @xl:border-b-0">
						<ul
							aria-label={m.edit_skill_files()}
							className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2"
						>
							{files.map((f) => (
								<li key={f.path}>
									<Button
										size="sm"
										variant={f.path === open ? "secondary" : "ghost"}
										aria-current={f.path === open || undefined}
										className="w-full justify-start font-mono font-normal"
										onClick={() => setOpen(f.path)}
									>
										<FileIcon data-icon="inline-start" />
										<span className="truncate">{f.path}</span>
									</Button>
								</li>
							))}
						</ul>
						<form
							className="border-t p-2"
							onSubmit={(e) => {
								e.preventDefault();
								add();
							}}
						>
							<InputGroup>
								<InputGroupInput
									className="font-mono text-xs"
									placeholder={m.skill_new_file()}
									aria-label={m.skill_new_file()}
									value={newPath}
									onChange={(e) => setNewPath(e.target.value)}
								/>
								<InputGroupAddon align="inline-end">
									<InputGroupButton
										type="submit"
										size="icon-xs"
										aria-label={m.add_skill_file()}
									>
										<PlusIcon />
									</InputGroupButton>
								</InputGroupAddon>
							</InputGroup>
						</form>
					</div>
					{file && (
						<div className="flex min-h-64 min-w-0 flex-1 flex-col">
							<div className="flex items-center gap-2 border-b py-1.5 pr-1.5 pl-3">
								<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
									{file.path}
								</span>
								<Button
									size="icon-sm"
									variant="ghost"
									aria-label={`${m.delete()} ${file.path}`}
									onClick={() =>
										setFiles(files.filter((f) => f.path !== file.path))
									}
								>
									<Trash2Icon />
								</Button>
							</div>
							{file.text === undefined ? (
								<p className="p-3 text-sm text-muted-foreground">
									{m.skill_binary_file({ size: file.size })}
								</p>
							) : (
								<Textarea
									aria-label={file.path}
									// fills the pane: no own border or auto-grow
									className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-xs shadow-none field-sizing-fixed focus-visible:ring-0 md:text-xs dark:bg-transparent"
									value={file.text}
									onChange={(e) =>
										setFiles(
											files.map((f) =>
												f.path === file.path
													? { ...f, text: e.target.value }
													: f,
											),
										)
									}
								/>
							)}
						</div>
					)}
				</div>
				<FieldError>{error}</FieldError>
			</div>
			<SheetFooter className="flex-row border-t">
				<Button disabled={busy} onClick={() => void save()}>
					{busy && (
						<Loader2Icon data-icon="inline-start" className="animate-spin" />
					)}
					{m.skill_save_version()}
				</Button>
				<Button variant="ghost" disabled={busy} onClick={onClose}>
					{m.cancel()}
				</Button>
			</SheetFooter>
		</>
	);
}
