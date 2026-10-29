export const themes = ["system", "light", "dark"] as const;
export type Theme = (typeof themes)[number];

/** Toggles `.dark` on <html> from the stored choice; anything but light/dark follows the system. */
export function applyTheme() {
	const theme = localStorage.getItem("theme");
	document.documentElement.classList.toggle(
		"dark",
		theme === "dark" ||
			(theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches),
	);
}

// Runs in <head> before paint (no flash) and keeps "system" in sync with OS changes
export const themeScript = `(${applyTheme})();matchMedia("(prefers-color-scheme: dark)").addEventListener("change",${applyTheme})`;
