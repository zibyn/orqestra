import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { defineConfig } from "vitest/config";

// Keeps tests off vite.config.ts, whose Start/nitro plugins keep the process alive;
// paraglide as there, so the messages tests import are compiled in a fresh checkout too
export default defineConfig({
	plugins: [
		paraglideVitePlugin({
			project: "./project.inlang",
			outdir: "./src/paraglide",
			strategy: ["cookie", "baseLocale"],
		}),
	],
});
