// PROTOTYPE (#81 MCP 连接流程界面): throwaway, never merge to main.
// Three variants of the connection card, appended to any Conversation with `?proto=1`,
// switchable via `?variant=A|B|C` and `?step=…`. All data is fake; buttons only move `step`.
import { Link, useNavigate } from "@tanstack/react-router";
import {
	CheckIcon,
	ExternalLinkIcon,
	Loader2Icon,
	PlugIcon,
	PlugZapIcon,
	ShieldCheckIcon,
	TriangleAlertIcon,
	WrenchIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { MessageResponse } from "#/components/ai-elements/message";
import {
	PrototypeSwitcher,
	useProto,
} from "#/components/PrototypeSwitcher.prototype";
import { Alert, AlertDescription } from "#/components/ui/alert";
import { Bubble, BubbleContent } from "#/components/ui/bubble";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
import { Marker, MarkerContent } from "#/components/ui/marker";
import { Message, MessageContent } from "#/components/ui/message";
import {
	Trace,
	TraceDescription,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "#/components/ui/trace";

export const VARIANTS = [
	{ key: "A", label: "回复里的轻卡片" },
	{ key: "B", label: "停靠在输入框上方" },
	{ key: "C", label: "完整的授权说明卡" },
];
export const STEPS = [
	{ key: "waiting", label: "等待连接" },
	{ key: "reconnect", label: "需要重新连接" },
	{ key: "authorizing", label: "授权中（弹窗已打开）" },
	{ key: "failed", label: "授权没完成" },
	{ key: "retrying", label: "已连接，Agent 重试中" },
	{ key: "done", label: "已连接，重试完成" },
	{ key: "declined", label: "点了「不连接」" },
	{ key: "superseded", label: "User 发了别的消息" },
];
type Step = (typeof STEPS)[number]["key"];

const SERVER = "GitHub";
const TOOL = "search_issues";
const ARGS = "repo:zibyn/orqestra is:open label:bug";

function useStep() {
	const step = useProto("step", STEPS) as Step;
	const navigate = useNavigate();
	const goto = (s: Step) =>
		void navigate({
			to: ".",
			search: (p: Record<string, unknown>) => ({ ...p, step: s }),
			replace: true,
		} as never);
	return { step, goto };
}

const open = (s: Step) =>
	s === "waiting" || s === "reconnect" || s === "authorizing" || s === "failed";
const connected = (s: Step) => s === "retrying" || s === "done";

const UserSays = ({ children }: { children: ReactNode }) => (
	<Message align="end">
		<MessageContent>
			<Bubble align="end" variant="muted">
				<BubbleContent className="rounded-2xl px-4 py-2.5 text-base whitespace-pre-wrap">
					{children}
				</BubbleContent>
			</Bubble>
		</MessageContent>
	</Message>
);

const Agent = ({ children }: { children: ReactNode }) => (
	<Message>
		<MessageContent className="gap-3">{children}</MessageContent>
	</Message>
);

function ToolLine({
	status,
	note,
}: {
	status?: "running" | "error" | "pending";
	note?: string;
}) {
	return (
		<TraceLine status={status}>
			<TraceIcon>
				{status === "running" ? (
					<Loader2Icon className="animate-spin text-signal" />
				) : status === "pending" ? (
					<PlugIcon />
				) : (
					<WrenchIcon />
				)}
			</TraceIcon>
			<TraceTitle>
				{SERVER} · {TOOL}
			</TraceTitle>
			<TraceDescription className="min-w-0 shrink truncate">
				{note ?? ARGS}
			</TraceDescription>
		</TraceLine>
	);
}

/** Where the Connection's input woke the Conversation, like TimerRang. */
const ConnectedMarker = () => (
	<Marker variant="separator" className="text-xs">
		<MarkerContent>
			<PlugZapIcon className="size-3" />
			已连接 {SERVER}
		</MarkerContent>
	</Marker>
);

/** What follows the card: the retry, the reply to 不连接, or the other message. */
function Aftermath({ step }: { step: Step }) {
	if (connected(step))
		return (
			<>
				<ConnectedMarker />
				<Agent>
					<Trace>
						<ToolLine status={step === "retrying" ? "running" : undefined} />
					</Trace>
					{step === "done" && (
						<MessageResponse>
							{
								"连上了。仓库里还开着 3 个 bug：\n\n1. **#91 上传超过 50 MB 的附件会卡住**：影响所有 User，优先修\n2. **#88 Firing 的时区在夏令时切换日偏一小时**\n3. **#73 控制台在窄屏下表格溢出**"
							}
						</MessageResponse>
					)}
				</Agent>
			</>
		);
	if (step === "declined")
		return (
			<>
				<UserSays>不连接</UserSays>
				<Agent>
					<MessageResponse>
						好的。没有 GitHub 的访问我查不到 issue；你可以把 issue
						列表贴过来，我来排优先级。
					</MessageResponse>
				</Agent>
			</>
		);
	if (step === "superseded")
		return (
			<>
				<UserSays>算了，先帮我写个周报大纲</UserSays>
				<Agent>
					<MessageResponse>好的，下面是一个周报大纲……</MessageResponse>
				</Agent>
			</>
		);
	return null;
}

const prompt = (step: Step) =>
	step === "reconnect"
		? `你的 ${SERVER} 连接已失效，需要重新连接，Agent 才能继续。`
		: `Agent 想用 ${SERVER} 的 ${TOOL}，需要先连接你自己的 ${SERVER} 账号。连接后 Agent 会接着做。`;

/** A: a light card inside the Agent's reply, like TaskDraftCard; collapses to one line once settled. */
function VariantA({ step, goto }: ReturnType<typeof useStep>) {
	const card = open(step) ? (
		<div className="flex flex-col gap-2 border-y py-3 text-sm">
			<p className="flex items-center gap-2 font-medium">
				<PlugIcon className="size-4 shrink-0 text-muted-foreground" />
				{step === "reconnect" ? `重新连接 ${SERVER}` : `连接 ${SERVER}`}
			</p>
			{step === "authorizing" ? (
				<p className="flex items-center gap-2 text-muted-foreground">
					<Loader2Icon className="size-4 animate-spin" />
					正在等待 {SERVER} 授权，请在弹出的窗口里完成。
					<button
						type="button"
						className="underline"
						onClick={() => goto("authorizing")}
					>
						没看到窗口？
					</button>
				</p>
			) : (
				<p className="text-muted-foreground">{prompt(step)}</p>
			)}
			{step === "failed" && (
				<p className="text-destructive">
					授权没有完成：你在 {SERVER} 取消了授权。
				</p>
			)}
			<div className="flex gap-2">
				{step === "authorizing" ? (
					<>
						<Button
							size="sm"
							variant="outline"
							onClick={() => goto("retrying")}
						>
							（原型：模拟授权成功）
						</Button>
						<Button size="sm" variant="outline" onClick={() => goto("failed")}>
							（原型：模拟授权失败）
						</Button>
					</>
				) : (
					<>
						<Button size="sm" onClick={() => goto("authorizing")}>
							<ExternalLinkIcon data-icon="inline-start" />
							{step === "failed"
								? "再试一次"
								: step === "reconnect"
									? "重新连接"
									: `连接 ${SERVER}`}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => goto("declined")}>
							不连接
						</Button>
					</>
				)}
			</div>
		</div>
	) : (
		<p className="flex items-center gap-2 text-sm text-muted-foreground">
			{connected(step) ? (
				<CheckIcon className="size-4" />
			) : (
				<PlugIcon className="size-4" />
			)}
			{connected(step) ? `已连接 ${SERVER}` : `没有连接 ${SERVER}`}
			{step === "superseded" && (
				<Link to="/prototype/connections" className="underline">
					去「连接」页
				</Link>
			)}
		</p>
	);
	return (
		<>
			<Agent>
				<MessageResponse>我去 GitHub 上查一下。</MessageResponse>
				<Trace>
					<ToolLine status="pending" note={`等待连接 ${SERVER}`} />
				</Trace>
				{card}
			</Agent>
			<Aftermath step={step} />
		</>
	);
}

/** B: the thread keeps only a Trace line; the ask docks above the Composer until it is settled. */
function VariantB({ step }: ReturnType<typeof useStep>) {
	return (
		<>
			<Agent>
				<MessageResponse>我去 GitHub 上查一下。</MessageResponse>
				<Trace>
					<ToolLine
						status={open(step) ? "pending" : undefined}
						note={
							open(step)
								? `等待连接 ${SERVER}`
								: connected(step)
									? `已连接 ${SERVER}`
									: `没有连接 ${SERVER}`
						}
					/>
				</Trace>
			</Agent>
			<Aftermath step={step} />
		</>
	);
}

/** B's dock, rendered above the Composer. */
export function ConnectionDockPrototype() {
	const variant = useProto("variant", VARIANTS);
	const { step, goto } = useStep();
	if (variant !== "B" || !open(step)) return null;
	return (
		<div className="mx-auto w-full max-w-3xl px-4">
			<div className="flex flex-wrap items-center gap-3 rounded-t-xl border border-b-0 bg-muted/60 px-4 py-2.5 text-sm">
				{step === "authorizing" ? (
					<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
				) : step === "failed" ? (
					<TriangleAlertIcon className="size-4 text-destructive" />
				) : (
					<PlugIcon className="size-4 text-muted-foreground" />
				)}
				<span className="min-w-0 flex-1">
					{step === "authorizing"
						? `正在等待 ${SERVER} 授权……`
						: step === "failed"
							? `授权没有完成：你在 ${SERVER} 取消了授权。`
							: step === "reconnect"
								? `${SERVER} 的连接已失效，重新连接后 Agent 继续`
								: `连接 ${SERVER} 后 Agent 继续`}
					<span className="block text-xs text-muted-foreground">
						或者直接在下面说点别的
					</span>
				</span>
				{step === "authorizing" ? (
					<>
						<Button
							size="sm"
							variant="outline"
							onClick={() => goto("retrying")}
						>
							（模拟成功）
						</Button>
						<Button size="sm" variant="outline" onClick={() => goto("failed")}>
							（模拟失败）
						</Button>
					</>
				) : (
					<>
						<Button size="sm" variant="ghost" onClick={() => goto("declined")}>
							不连接
						</Button>
						<Button size="sm" onClick={() => goto("authorizing")}>
							<ExternalLinkIcon data-icon="inline-start" />
							{step === "failed"
								? "再试一次"
								: step === "reconnect"
									? "重新连接"
									: "连接"}
						</Button>
					</>
				)}
			</div>
		</div>
	);
}

/** C: a full consent-style card that says what connecting means; settles to the marker or a muted line. */
function VariantC({ step, goto }: ReturnType<typeof useStep>) {
	return (
		<>
			<Agent>
				<MessageResponse>我去 GitHub 上查一下。</MessageResponse>
				{open(step) ? (
					<Card className="w-full max-w-md">
						<CardHeader>
							<CardTitle className="flex items-center gap-2">
								<PlugIcon className="size-4" />
								{step === "reconnect" ? `重新连接 ${SERVER}` : `连接 ${SERVER}`}
							</CardTitle>
							<CardDescription>{prompt(step)}</CardDescription>
						</CardHeader>
						<CardContent className="flex flex-col gap-3 text-sm">
							<div className="rounded-md bg-muted px-3 py-2 font-mono text-xs">
								{TOOL}({ARGS})
							</div>
							<ul className="flex flex-col gap-1.5 text-muted-foreground">
								<li className="flex gap-2">
									<ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
									Agent 会以你的身份调用 {SERVER}，只能做你的账号能做的事。
								</li>
								<li className="flex gap-2">
									<ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
									你的定时任务也会用这个连接。随时可以在「连接」页断开。
								</li>
							</ul>
							{step === "failed" && (
								<Alert variant="destructive">
									<TriangleAlertIcon />
									<AlertDescription>
										授权没有完成：你在 {SERVER} 取消了授权。
									</AlertDescription>
								</Alert>
							)}
						</CardContent>
						<CardFooter className="gap-2">
							{step === "authorizing" ? (
								<>
									<Button size="sm" disabled>
										<Loader2Icon
											className="animate-spin"
											data-icon="inline-start"
										/>
										等待授权……
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => goto("retrying")}
									>
										（模拟成功）
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => goto("failed")}
									>
										（模拟失败）
									</Button>
								</>
							) : (
								<>
									<Button size="sm" onClick={() => goto("authorizing")}>
										<ExternalLinkIcon data-icon="inline-start" />
										{step === "failed"
											? "再试一次"
											: step === "reconnect"
												? "重新连接"
												: `连接 ${SERVER}`}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => goto("declined")}
									>
										不连接
									</Button>
								</>
							)}
						</CardFooter>
					</Card>
				) : (
					<Trace>
						<ToolLine
							status={connected(step) ? undefined : "error"}
							note={connected(step) ? `已连接 ${SERVER}` : `没有连接 ${SERVER}`}
						/>
					</Trace>
				)}
			</Agent>
			<Aftermath step={step} />
		</>
	);
}

/** The scenario, appended at the end of the thread. */
export function ConnectionThreadPrototype() {
	const variant = useProto("variant", VARIANTS);
	const s = useStep();
	return (
		<>
			<UserSays>帮我看看 orqestra 仓库里还开着的 bug，按优先级排一下</UserSays>
			{variant === "A" && <VariantA {...s} />}
			{variant === "B" && <VariantB {...s} />}
			{variant === "C" && <VariantC {...s} />}
			<PrototypeSwitcher
				axes={[
					{ param: "variant", options: VARIANTS },
					{ param: "step", options: STEPS },
				]}
			/>
		</>
	);
}
