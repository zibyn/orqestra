// PROTOTYPE (#81 MCP 连接流程界面): throwaway, never merge to main.
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type Option = { key: string; label: string };

/** Reads one prototype search param, defaulting to the first option. */
export function useProto(param: string, options: Option[]) {
	const search = useSearch({ strict: false }) as Record<string, unknown>;
	const value = String(search[param] ?? options[0].key);
	return options.some((o) => o.key === value) ? value : options[0].key;
}

/** A floating bar of prototype axes (variant, step…); ←/→ cycle the first one. */
export function PrototypeSwitcher({
	axes,
}: {
	axes: { param: string; options: Option[] }[];
}) {
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as Record<string, unknown>;
	const current = (param: string, options: Option[]) =>
		Math.max(
			0,
			options.findIndex((o) => o.key === String(search[param])),
		);
	const go = (param: string, options: Option[], delta: number) => {
		const i =
			(current(param, options) + delta + options.length) % options.length;
		void navigate({
			to: ".",
			search: (s: Record<string, unknown>) => ({
				...s,
				[param]: options[i].key,
			}),
			replace: true,
		} as never);
	};

	// client-only, so SSR and hydration agree
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	useEffect(() => {
		const first = axes[0];
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement;
			if (t.closest("input, textarea, [contenteditable]")) return;
			if (e.key === "ArrowLeft") go(first.param, first.options, -1);
			if (e.key === "ArrowRight") go(first.param, first.options, 1);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	if (!import.meta.env.DEV || !mounted) return null;
	// portalled: the message scroller's transform would pin a fixed bar inside it
	return createPortal(
		<div className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-1 rounded-2xl bg-fuchsia-700 p-1.5 text-xs text-white shadow-xl">
			{axes.map(({ param, options }) => (
				<div key={param} className="flex items-center gap-1">
					<button
						type="button"
						className="rounded-full p-1 hover:bg-white/20"
						onClick={() => go(param, options, -1)}
					>
						<ChevronLeftIcon className="size-4" />
					</button>
					<span className="min-w-56 text-center">
						{param}: {options[current(param, options)].key} (
						{options[current(param, options)].label})
					</span>
					<button
						type="button"
						className="rounded-full p-1 hover:bg-white/20"
						onClick={() => go(param, options, 1)}
					>
						<ChevronRightIcon className="size-4" />
					</button>
				</div>
			))}
		</div>,
		document.body,
	);
}
