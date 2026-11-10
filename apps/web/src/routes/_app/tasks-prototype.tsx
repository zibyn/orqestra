// PROTOTYPE, throwaway (wayfinder ticket #61 "定时任务 UI 的形态"). Never merge to main.
// Three structurally different Scheduled Task UIs on /tasks-prototype, switched by ?variant=A|B|C.
// Each variant shows: the task list, the create/edit form, the Firing history, and how
// Firing-started Conversations would sit in the sidebar (a mock panel, the real AppSidebar is untouched).
// Agents and Models are real (the /_app loader); tasks and history are in-memory stubs; nothing saves.
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import {
	BanIcon,
	CalendarClockIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	CircleHelpIcon,
	EyeOffIcon,
	Loader2Icon,
	PauseCircleIcon,
	PlusIcon,
	SkipForwardIcon,
	XCircleIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { AgentOption } from "#/components/Composer";
import { FormSheet, Item, ItemList, SheetForm } from "#/components/ConsolePage";
import { Picker } from "#/components/Picker";
import { PrototypeSwitcher } from "#/components/PrototypeSwitcher";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
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
import { Textarea } from "#/components/ui/textarea";
import { cn } from "#/lib/utils";

const VARIANTS = [
	{ key: "A", name: "列表 + 抽屉" },
	{ key: "B", name: "主从两栏" },
	{ key: "C", name: "日程时间线" },
];

export const Route = createFileRoute("/_app/tasks-prototype")({
	validateSearch: (s: Record<string, unknown>) => ({
		variant: typeof s.variant === "string" ? s.variant : "A",
	}),
	component: Prototype,
});

const appRoute = getRouteApi("/_app");

function Prototype() {
	const { variant } = Route.useSearch();
	const { agents } = appRoute.useLoaderData();
	return (
		<div className="flex-1 overflow-y-auto px-4 py-6 pb-24 md:px-10 md:py-10">
			{variant === "A" && <VariantA agents={agents} />}
			{variant === "B" && <VariantB agents={agents} />}
			{variant === "C" && <VariantC agents={agents} />}
			<PrototypeSwitcher variants={VARIANTS} current={variant} />
		</div>
	);
}

// ---------- stub data ----------

type Schedule =
	| { kind: "once"; at: string }
	| {
			kind: "interval";
			every: number;
			unit: "hour" | "day" | "week";
			end?: string;
	  }
	| { kind: "cron"; expr: string; end?: string };
type State = "enabled" | "paused" | "auto-paused" | "finished";
type Firing = {
	at: string;
	outcome:
		| "running"
		| "completed"
		| "partial"
		| "question"
		| "skipped"
		| "failed";
	conversation?: string;
	unread?: boolean;
	reason?: string;
};
type Task = {
	id: string;
	name: string;
	prompt: string;
	schedule: Schedule;
	timeZone: string;
	incognito: boolean;
	alertOnComplete: boolean;
	state: State;
	next?: string;
	firings: Firing[];
};

const TASKS: Task[] = [
	{
		id: "t1",
		name: "每日行业新闻简报",
		prompt:
			"搜索过去 24 小时 AI 基础设施相关新闻，按重要性排序，写一份 10 条以内的简报。",
		schedule: { kind: "cron", expr: "0 9 * * 1-5" },
		timeZone: "Asia/Shanghai",
		incognito: false,
		alertOnComplete: true,
		state: "enabled",
		next: "11月11日 周三 09:00",
		firings: [
			{
				at: "11月10日 09:00",
				outcome: "completed",
				conversation: "AI 基础设施简报 · 11/10",
				unread: true,
			},
			{
				at: "11月9日 09:00",
				outcome: "partial",
				conversation: "AI 基础设施简报 · 11/9",
				reason: "达到 50 步上限",
			},
			{
				at: "11月6日 09:00",
				outcome: "question",
				conversation: "AI 基础设施简报 · 11/6",
				reason: "Agent 在等你回复",
			},
			{
				at: "11月5日 09:00",
				outcome: "completed",
				conversation: "AI 基础设施简报 · 11/5",
			},
		],
	},
	{
		id: "t2",
		name: "仓库依赖巡检",
		prompt:
			"克隆 zibyn/orqestra，检查过期和有安全公告的依赖，列出需要升级的包。",
		schedule: { kind: "interval", every: 6, unit: "hour" },
		timeZone: "Asia/Shanghai",
		incognito: true,
		alertOnComplete: false,
		state: "auto-paused",
		firings: [
			{
				at: "11月10日 06:00",
				outcome: "failed",
				reason: "Model 已被 Admin 停用",
			},
			{
				at: "11月10日 00:00",
				outcome: "failed",
				reason: "Model 已被 Admin 停用",
			},
			{
				at: "11月9日 18:00",
				outcome: "failed",
				reason: "Model 已被 Admin 停用",
			},
			{
				at: "11月9日 12:00",
				outcome: "skipped",
				reason: "上一次的 Conversation 仍在运行",
			},
			{
				at: "11月9日 06:00",
				outcome: "completed",
				conversation: "依赖巡检 · 11/9 06:00",
			},
		],
	},
	{
		id: "t3",
		name: "提醒续费域名",
		prompt: "查一下 orqestra.dev 的到期时间，列出续费步骤。",
		schedule: { kind: "once", at: "2026-11-08T10:00" },
		timeZone: "Asia/Shanghai",
		incognito: false,
		alertOnComplete: true,
		state: "finished",
		firings: [
			{
				at: "11月8日 10:00",
				outcome: "completed",
				conversation: "域名续费步骤",
			},
		],
	},
	{
		id: "t4",
		name: "周报草稿",
		prompt: "根据我本周的 Memory 和 Conversation，起草一份周报。",
		schedule: { kind: "cron", expr: "0 17 * * 5" },
		timeZone: "Europe/Berlin",
		incognito: false,
		alertOnComplete: true,
		state: "paused",
		firings: [
			{
				at: "11月6日 17:00",
				outcome: "running",
				conversation: "周报草稿 · 第 45 周",
			},
		],
	},
];

const ORDINARY = ["重构 Inbox 的思路", "BullMQ 调研笔记", "Untitled"];

function describe(s: Schedule, tz: string) {
	const zone =
		tz === Intl.DateTimeFormat().resolvedOptions().timeZone ? "" : ` (${tz})`;
	if (s.kind === "once") return `一次 · ${s.at.replace("T", " ")}${zone}`;
	if (s.kind === "interval")
		return `每 ${s.every} ${{ hour: "小时", day: "天", week: "周" }[s.unit]}${zone}`;
	const human: Record<string, string> = {
		"0 9 * * 1-5": "工作日 09:00",
		"0 17 * * 5": "每周五 17:00",
	};
	return `${human[s.expr] ?? s.expr}${zone}`;
}

const STATE_BADGE: Record<State, ReactNode> = {
	enabled: <Badge variant="secondary">启用</Badge>,
	paused: <Badge variant="outline">已暂停</Badge>,
	"auto-paused": <Badge variant="destructive">连续 3 次失败，已自动暂停</Badge>,
	finished: <Badge variant="outline">已结束</Badge>,
};

const OUTCOME: Record<Firing["outcome"], { icon: ReactNode; label: string }> = {
	running: {
		icon: <Loader2Icon className="size-4 animate-spin text-signal" />,
		label: "运行中",
	},
	completed: {
		icon: <CheckCircle2Icon className="size-4 text-emerald-600" />,
		label: "完成",
	},
	partial: {
		icon: <PauseCircleIcon className="size-4 text-amber-600" />,
		label: "部分完成",
	},
	question: {
		icon: <CircleHelpIcon className="size-4 text-sky-600" />,
		label: "等你回复",
	},
	skipped: {
		icon: <SkipForwardIcon className="size-4 text-muted-foreground" />,
		label: "已跳过",
	},
	failed: {
		icon: <XCircleIcon className="size-4 text-destructive" />,
		label: "失败",
	},
};

function ConversationLink({ f }: { f: Firing }) {
	if (!f.conversation)
		return <span className="text-muted-foreground">{f.reason}</span>;
	return (
		<span className="flex items-center gap-2">
			{/* stub: would link to /c/$conversationId */}
			<a href="#conversation" className="text-link underline">
				{f.conversation}
			</a>
			{f.unread && (
				<span
					role="img"
					className="size-2 rounded-full bg-signal"
					aria-label="Unread"
				/>
			)}
			{f.reason && (
				<span className="text-xs text-muted-foreground">{f.reason}</span>
			)}
		</span>
	);
}

/** Mock of the app sidebar's content, to judge how Firing Conversations sit next to ordinary ones. */
function SidebarMock({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<aside className="w-64 shrink-0 rounded-xl border bg-sidebar p-2 text-sm">
			<p className="px-2 pb-2 text-xs font-medium text-muted-foreground">
				侧栏预览 · {title}
			</p>
			{children}
		</aside>
	);
}

function Row({
	icon,
	children,
	sub,
	unread,
}: {
	icon?: ReactNode;
	children: ReactNode;
	sub?: string;
	unread?: boolean;
}) {
	return (
		<div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent">
			{icon}
			<div className="min-w-0 flex-1">
				<p className={cn("truncate", unread && "font-semibold")}>{children}</p>
				{sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
			</div>
			{unread && <span className="size-2 rounded-full bg-signal" />}
		</div>
	);
}

// ---------- the form fields A and B share (C has its own sentence form) ----------

function TaskFields({ task, agents }: { task?: Task; agents: AgentOption[] }) {
	const [kind, setKind] = useState<Schedule["kind"]>(
		task?.schedule.kind ?? "cron",
	);
	const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
	const agent = agents.find((a) => a.id === agentId) ?? agents[0];
	const [model, setModel] = useState(agent?.defaultModel ?? "");
	const picked = agent?.models.find((x) => x.ref === model) ?? agent?.models[0];
	const [thinking, setThinking] = useState<string>(
		picked?.thinking.default ?? "",
	);
	const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const [tz, setTz] = useState(task?.timeZone ?? browserTz);
	const zones = [
		...new Set([
			browserTz,
			"Asia/Shanghai",
			"Europe/Berlin",
			"America/New_York",
			"UTC",
		]),
	];

	return (
		<FieldGroup className="gap-5">
			<Field>
				<FieldLabel htmlFor="p-name">名称</FieldLabel>
				<Input id="p-name" defaultValue={task?.name} />
			</Field>
			<Field>
				<FieldLabel htmlFor="p-prompt">提示</FieldLabel>
				<Textarea
					id="p-prompt"
					className="min-h-28"
					defaultValue={task?.prompt}
				/>
			</Field>
			<div className="flex flex-wrap gap-4">
				{agent && (
					<Picker
						label="Agent"
						value={agent.id}
						onChange={setAgentId}
						items={agents.map((a) => ({ value: a.id, label: a.name }))}
					/>
				)}
				{agent && agent.models.length > 1 && (
					<Picker
						label="Model"
						value={picked?.ref ?? ""}
						onChange={setModel}
						items={agent.models.map((x) => ({ value: x.ref, label: x.name }))}
					/>
				)}
				{picked && picked.thinking.allowed.length > 1 && (
					<Picker
						label="Thinking"
						value={thinking}
						onChange={setThinking}
						items={picked.thinking.allowed.map((l) => ({ value: l, label: l }))}
					/>
				)}
			</div>
			<Field>
				<FieldLabel>计划</FieldLabel>
				<div className="flex gap-1 rounded-lg border p-1">
					{(["once", "interval", "cron"] as const).map((k) => (
						<Button
							key={k}
							type="button"
							size="sm"
							variant={kind === k ? "secondary" : "ghost"}
							className="flex-1"
							onClick={() => setKind(k)}
						>
							{{ once: "一次", interval: "每隔", cron: "Cron" }[k]}
						</Button>
					))}
				</div>
				{kind === "once" && (
					<Input type="datetime-local" defaultValue="2026-11-12T09:00" />
				)}
				{kind === "interval" && (
					<div className="flex items-center gap-2">
						<span>每</span>
						<Input type="number" min={1} defaultValue={6} className="w-20" />
						<Picker
							label="单位"
							value="hour"
							onChange={() => {}}
							items={[
								{ value: "hour", label: "小时" },
								{ value: "day", label: "天" },
								{ value: "week", label: "周" },
							]}
						/>
					</div>
				)}
				{kind === "cron" && (
					<>
						<Input
							className="font-mono"
							defaultValue={
								task?.schedule.kind === "cron"
									? task.schedule.expr
									: "0 9 * * 1-5"
							}
						/>
						<p className="text-xs text-muted-foreground">
							工作日 09:00 · 下次 11月11日 周三 09:00、11月12日 周四
							09:00、11月13日 周五 09:00
						</p>
					</>
				)}
				{kind !== "once" && (
					<div className="flex items-center gap-2 text-sm">
						<Label htmlFor="p-end">结束于（可选）</Label>
						<Input id="p-end" type="date" className="w-44" />
					</div>
				)}
			</Field>
			<Picker
				label="时区"
				value={tz}
				onChange={setTz}
				items={zones.map((z) => ({
					value: z,
					label: z === browserTz ? `${z}（浏览器）` : z,
				}))}
			/>
			<div className="flex flex-col gap-3">
				<Toggle
					id="p-incognito"
					label="Incognito：不读写 Memory，不被 Conversation 搜索找到"
					on={task?.incognito}
				/>
				<Toggle
					id="p-alert"
					label="完成时发 Alert（失败和提问总会发）"
					on={task?.alertOnComplete ?? true}
				/>
				<Toggle
					id="p-enabled"
					label="启用"
					on={task ? task.state === "enabled" : true}
				/>
			</div>
		</FieldGroup>
	);
}

function Toggle({
	id,
	label,
	on,
}: {
	id: string;
	label: string;
	on?: boolean;
}) {
	return (
		<div className="flex items-center gap-2">
			<Switch id={id} defaultChecked={on} />
			<Label htmlFor={id}>{label}</Label>
		</div>
	);
}

function History({ firings }: { firings: Firing[] }) {
	return (
		<ul className="flex flex-col gap-2">
			{firings.map((f) => (
				<li key={f.at} className="flex items-start gap-2 text-sm">
					{OUTCOME[f.outcome].icon}
					<span className="w-28 shrink-0 text-muted-foreground">{f.at}</span>
					<ConversationLink f={f} />
				</li>
			))}
		</ul>
	);
}

// ---------- A: the Memory-page pattern. List rows, a drawer holds form + history; Firing Conversations inline in the sidebar ----------

function VariantA({ agents }: { agents: AgentOption[] }) {
	const [open, setOpen] = useState<Task | "new">();
	const task = open === "new" ? undefined : open;
	return (
		<div className="mx-auto flex max-w-6xl gap-8">
			<SidebarMock title="混在 Conversation 列表里，带时钟图标">
				<Row
					icon={<CalendarClockIcon className="size-4 text-muted-foreground" />}
					sub="每日行业新闻简报"
					unread
				>
					AI 基础设施简报 · 11/10
				</Row>
				<Row>{ORDINARY[0]}</Row>
				<Row
					icon={<CalendarClockIcon className="size-4 text-muted-foreground" />}
					sub="每日行业新闻简报"
				>
					AI 基础设施简报 · 11/9
				</Row>
				<Row
					icon={<EyeOffIcon className="size-4 text-muted-foreground" />}
					sub="仓库依赖巡检"
				>
					依赖巡检 · 11/9 06:00
				</Row>
				<Row>{ORDINARY[1]}</Row>
				<Row
					icon={<CalendarClockIcon className="size-4 text-muted-foreground" />}
					sub="提醒续费域名"
				>
					域名续费步骤
				</Row>
				<Row>{ORDINARY[2]}</Row>
				<p className="px-2 pt-3 text-xs text-muted-foreground">
					入口：用户菜单 → 定时任务（与 Memory 并列）
				</p>
			</SidebarMock>
			<div className="flex min-w-0 flex-1 flex-col gap-6">
				<header className="flex flex-wrap items-end justify-between gap-4">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight">定时任务</h1>
						<p className="text-sm text-muted-foreground">
							按计划把提示发给 Agent，每次在新 Conversation 里运行。
						</p>
					</div>
					<Button onClick={() => setOpen("new")}>
						<PlusIcon />
						新建定时任务
					</Button>
				</header>
				<ItemList>
					{TASKS.map((t) => {
						const last = t.firings[0];
						return (
							<Item
								key={t.id}
								title={
									<>
										{t.name}
										{STATE_BADGE[t.state]}
										{t.incognito && (
											<EyeOffIcon
												className="size-4 text-muted-foreground"
												aria-label="Incognito"
											/>
										)}
									</>
								}
								description={`${describe(t.schedule, t.timeZone)}${t.next ? ` · 下次 ${t.next}` : ""}`}
								actions={
									<>
										<Switch
											defaultChecked={t.state === "enabled"}
											aria-label="启用"
										/>
										<Button
											size="sm"
											variant="outline"
											onClick={() => setOpen(t)}
										>
											打开
										</Button>
									</>
								}
							>
								{last && (
									<p className="flex items-center gap-2 text-xs">
										{OUTCOME[last.outcome].icon} 上次 {last.at} ·{" "}
										{OUTCOME[last.outcome].label}
									</p>
								)}
							</Item>
						);
					})}
				</ItemList>
			</div>
			<FormSheet
				open={!!open}
				onClose={() => setOpen(undefined)}
				title={task?.name ?? "新建定时任务"}
				description={task && describe(task.schedule, task.timeZone)}
			>
				<SheetForm
					onSubmit={() => setOpen(undefined)}
					busy={false}
					submitLabel="保存"
					extra={
						task && (
							<Button type="button" variant="destructive">
								删除
							</Button>
						)
					}
				>
					<TaskFields task={task} agents={agents} />
					{task && (
						<section className="mt-8 flex flex-col gap-3 border-t pt-4">
							<h2 className="font-medium">运行记录</h2>
							<History firings={task.firings} />
						</section>
					)}
				</SheetForm>
			</FormSheet>
		</div>
	);
}

// ---------- B: master–detail. Task list left, a page per task with inline form and a history table; Firing Conversations in their own sidebar group ----------

function VariantB({ agents }: { agents: AgentOption[] }) {
	const [selected, setSelected] = useState<string>(TASKS[0].id);
	const task = TASKS.find((t) => t.id === selected);
	return (
		<div className="mx-auto flex max-w-7xl gap-6">
			<SidebarMock title="单独的「定时任务」分组，按任务折叠">
				<p className="px-2 pb-1 text-xs text-muted-foreground">定时任务</p>
				{TASKS.map((t) => (
					<Collapsible key={t.id} defaultOpen={t.id === "t1"}>
						<CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent">
							<CalendarClockIcon className="size-4 text-muted-foreground" />
							<span
								className={cn(
									"flex-1 truncate text-left",
									t.firings.some((f) => f.unread) && "font-semibold",
								)}
							>
								{t.name}
							</span>
							{t.state === "auto-paused" && (
								<XCircleIcon className="size-4 text-destructive" />
							)}
							<ChevronDownIcon className="size-4" />
						</CollapsibleTrigger>
						<CollapsibleContent className="pl-6">
							{t.firings
								.filter((f) => f.conversation)
								.slice(0, 3)
								.map((f) => (
									<Row key={f.at} unread={f.unread}>
										{f.at}
									</Row>
								))}
						</CollapsibleContent>
					</Collapsible>
				))}
				<p className="px-2 pt-3 pb-1 text-xs text-muted-foreground">
					Conversations
				</p>
				{ORDINARY.map((o) => (
					<Row key={o}>{o}</Row>
				))}
				<p className="px-2 pt-3 text-xs text-muted-foreground">
					Firing 的 Conversation 不进普通列表；User 回复后也留在任务下。
				</p>
			</SidebarMock>
			<nav className="flex w-56 shrink-0 flex-col gap-1">
				<Button variant="outline" className="mb-2 justify-start">
					<PlusIcon />
					新建
				</Button>
				{TASKS.map((t) => (
					<button
						key={t.id}
						type="button"
						onClick={() => setSelected(t.id)}
						className={cn(
							"flex flex-col items-start rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
							t.id === selected && "bg-muted",
						)}
					>
						<span className="flex items-center gap-2 font-medium">
							<span
								className={cn(
									"size-2 rounded-full",
									{
										enabled: "bg-emerald-500",
										paused: "bg-muted-foreground",
										"auto-paused": "bg-destructive",
										finished: "bg-border",
									}[t.state],
								)}
							/>
							{t.name}
						</span>
						<span className="text-xs text-muted-foreground">
							{describe(t.schedule, t.timeZone)}
						</span>
					</button>
				))}
			</nav>
			{task && (
				<div key={task.id} className="flex min-w-0 flex-1 flex-col gap-6">
					<header className="flex flex-wrap items-center gap-3">
						<h1 className="text-2xl font-semibold tracking-tight">
							{task.name}
						</h1>
						{STATE_BADGE[task.state]}
						<div className="ml-auto flex gap-2">
							<Button variant="outline">
								{task.state === "enabled" ? "暂停" : "启用"}
							</Button>
							<Button variant="ghost" className="text-destructive">
								删除
							</Button>
						</div>
					</header>
					{task.state === "auto-paused" && (
						<p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
							连续 3 次 Firing 失败（Model 已被 Admin 停用），已自动暂停。换个
							Model 后重新启用。
						</p>
					)}
					<section className="flex flex-col gap-2">
						<h2 className="font-medium">
							运行记录
							{task.next && (
								<span className="ml-2 text-sm font-normal text-muted-foreground">
									下次 {task.next}
								</span>
							)}
						</h2>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>时间</TableHead>
									<TableHead>结果</TableHead>
									<TableHead>Conversation / 原因</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{task.firings.map((f) => (
									<TableRow key={f.at}>
										<TableCell>{f.at}</TableCell>
										<TableCell>
											<span className="flex items-center gap-2">
												{OUTCOME[f.outcome].icon}
												{OUTCOME[f.outcome].label}
											</span>
										</TableCell>
										<TableCell>
											<ConversationLink f={f} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</section>
					<section className="flex flex-col gap-3 rounded-xl border p-4">
						<h2 className="font-medium">设置</h2>
						<TaskFields task={task} agents={agents} />
						<div>
							<Button>保存（下次 Firing 生效）</Button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}

// ---------- C: time first. One agenda of upcoming and past Firings across tasks, a sentence-builder to create; sidebar shows only one entry ----------

const UPCOMING = [
	{
		at: "今天 18:00",
		task: "仓库依赖巡检",
		note: "已自动暂停，不会运行",
		off: true,
	},
	{ at: "明天 09:00", task: "每日行业新闻简报" },
	{ at: "11月12日 09:00", task: "每日行业新闻简报" },
	{
		at: "11月13日 17:00",
		task: "周报草稿",
		note: "已暂停，不会运行",
		off: true,
	},
];

function VariantC({ agents }: { agents: AgentOption[] }) {
	const [filter, setFilter] = useState<string>();
	const [editing, setEditing] = useState<Task>();
	const past = TASKS.flatMap((t) =>
		t.firings.map((f) => ({ ...f, task: t })),
	).filter((f) => !filter || f.task.id === filter);
	return (
		<div className="mx-auto flex max-w-6xl gap-8">
			<SidebarMock title="不进 Conversation 列表，只有一个带未读数的入口">
				<Row icon={<CalendarClockIcon className="size-4" />} unread>
					定时任务 <Badge className="ml-1">1</Badge>
				</Row>
				<p className="px-2 pt-3 pb-1 text-xs text-muted-foreground">
					Conversations
				</p>
				{ORDINARY.map((o) => (
					<Row key={o}>{o}</Row>
				))}
				<p className="px-2 pt-3 text-xs text-muted-foreground">
					User 在 Firing 的 Conversation 里回复后，它才进入普通列表。
				</p>
			</SidebarMock>
			<div className="flex min-w-0 flex-1 flex-col gap-6">
				<h1 className="text-2xl font-semibold tracking-tight">定时任务</h1>
				<SentenceForm agents={agents} />
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant={filter ? "ghost" : "secondary"}
						onClick={() => setFilter(undefined)}
					>
						全部
					</Button>
					{TASKS.map((t) => (
						<Button
							key={t.id}
							size="sm"
							variant={filter === t.id ? "secondary" : "outline"}
							onClick={() => setFilter(t.id)}
						>
							{t.state === "auto-paused" && (
								<XCircleIcon className="text-destructive" />
							)}
							{(t.state === "paused" || t.state === "finished") && (
								<BanIcon className="text-muted-foreground" />
							)}
							{t.name}
						</Button>
					))}
				</div>
				{filter && (
					<p className="text-sm text-muted-foreground">
						{(() => {
							const t = TASKS.find((x) => x.id === filter);
							return (
								t && (
									<>
										{describe(t.schedule, t.timeZone)} · {STATE_BADGE[t.state]}{" "}
										<Button
											size="sm"
											variant="link"
											onClick={() => setEditing(t)}
										>
											编辑
										</Button>
									</>
								)
							);
						})()}
					</p>
				)}
				<section className="flex flex-col gap-2">
					<h2 className="text-sm font-medium text-muted-foreground">接下来</h2>
					<ol className="border-l pl-4">
						{UPCOMING.filter(
							(u) =>
								!filter || TASKS.find((t) => t.id === filter)?.name === u.task,
						).map((u) => (
							<li
								key={u.at + u.task}
								className={cn(
									"relative py-2 text-sm",
									u.off && "text-muted-foreground line-through",
								)}
							>
								<span className="absolute top-3.5 -left-[21px] size-2.5 rounded-full border-2 border-background bg-muted-foreground" />
								<span className="mr-3 font-mono">{u.at}</span>
								{u.task}
								{u.note && (
									<span className="ml-2 text-xs no-underline">{u.note}</span>
								)}
							</li>
						))}
					</ol>
				</section>
				<section className="flex flex-col gap-2">
					<h2 className="text-sm font-medium text-muted-foreground">已发生</h2>
					<ol className="border-l pl-4">
						{past.map((f) => (
							<li
								key={f.task.id + f.at}
								className="relative flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
							>
								<span className="absolute top-3 -left-[25px] rounded-full bg-background">
									{OUTCOME[f.outcome].icon}
								</span>
								<span className="font-mono">{f.at}</span>
								<span className="font-medium">{f.task.name}</span>
								<ConversationLink f={f} />
							</li>
						))}
					</ol>
				</section>
			</div>
			<FormSheet
				open={!!editing}
				onClose={() => setEditing(undefined)}
				title={editing?.name}
			>
				<SheetForm
					onSubmit={() => setEditing(undefined)}
					busy={false}
					submitLabel="保存"
				>
					<TaskFields task={editing} agents={agents} />
				</SheetForm>
			</FormSheet>
		</div>
	);
}

/** Creating reads as one sentence; the rarer fields hide behind 更多. */
function SentenceForm({ agents }: { agents: AgentOption[] }) {
	const [more, setMore] = useState(false);
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const sel = "h-8 rounded-md border bg-transparent px-2 text-sm";
	return (
		<form
			className="flex flex-col gap-3 rounded-xl border p-4"
			onSubmit={(e) => e.preventDefault()}
		>
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<select className={sel} defaultValue="cron-weekday" aria-label="频率">
					<option value="once">在</option>
					<option value="cron-weekday">每个工作日</option>
					<option value="daily">每天</option>
					<option value="weekly">每周一</option>
					<option value="interval">每隔 6 小时</option>
					<option value="cron">按 Cron…</option>
				</select>
				<input
					type="time"
					defaultValue="09:00"
					className={sel}
					aria-label="时间"
				/>
				<span className="text-muted-foreground">({tz})</span>
				<span>让</span>
				<select className={sel} aria-label="Agent">
					{agents.map((a) => (
						<option key={a.id}>{a.name}</option>
					))}
				</select>
				<span>执行：</span>
			</div>
			<Textarea
				placeholder="提示，例如：汇总过去 24 小时的行业新闻"
				className="min-h-20"
			/>
			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit">
					<PlusIcon />
					创建
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setMore(!more)}
				>
					更多：名称、Model、时区、结束日期、Incognito、Alert
				</Button>
			</div>
			{more && (
				<div className="grid gap-3 border-t pt-3 text-sm sm:grid-cols-2">
					<Input placeholder="名称（默认取提示开头）" />
					<Input type="date" aria-label="结束日期" />
					<Toggle id="c-incognito" label="Incognito" />
					<Toggle id="c-alert" label="完成时发 Alert" on />
				</div>
			)}
		</form>
	);
}
