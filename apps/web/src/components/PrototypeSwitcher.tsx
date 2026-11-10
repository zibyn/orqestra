// PROTOTYPE, throwaway: the floating ?variant= switcher for UI prototypes. Never merge to main.
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect } from "react";

export function PrototypeSwitcher({
	variants,
	current,
}: {
	variants: { key: string; name: string }[];
	current: string;
}) {
	const navigate = useNavigate();
	const i = Math.max(
		0,
		variants.findIndex((v) => v.key === current),
	);
	const go = (step: number) => {
		const next = variants[(i + step + variants.length) % variants.length];
		void navigate({
			to: ".",
			search: (s: object) => ({ ...s, variant: next.key }),
			replace: true,
		});
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement;
			if (t.closest("input, textarea, [contenteditable]")) return;
			if (e.key === "ArrowLeft") go(-1);
			if (e.key === "ArrowRight") go(1);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	if (!import.meta.env.DEV) return null;
	return (
		<div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black px-2 py-1.5 text-sm text-white shadow-lg ring-2 ring-yellow-400">
			<button
				type="button"
				aria-label="Previous variant"
				onClick={() => go(-1)}
			>
				<ChevronLeftIcon className="size-5" />
			</button>
			<span className="min-w-48 text-center font-mono">
				{variants[i].key} ({variants[i].name})
			</span>
			<button type="button" aria-label="Next variant" onClick={() => go(1)}>
				<ChevronRightIcon className="size-5" />
			</button>
		</div>
	);
}
