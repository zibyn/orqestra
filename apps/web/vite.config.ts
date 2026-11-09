import { paraglideVitePlugin } from "@inlang/paraglide-js";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { config as loadEnv } from "dotenv";
import { createProxyServer } from "httpxy";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";

// .env lives at the repo root; Start only loads env from the Vite root
loadEnv({ path: ["../../.env.local", "../../.env"], quiet: true });

// As Caddy does in Compose: /api/* and /auth/* go to the api, ahead of Start's handler (Vite's own proxy comes after it).
// shortcut: web still serves the /api routes excluded here until they move to the api; drop each as it does
const toApi = /^\/(auth\/|api\/(?!skills([?#]|$)))/;
const apiProxy = (): Plugin => ({
	name: "orqestra:api-proxy",
	configureServer(server) {
		const proxy = createProxyServer({ target: "http://localhost:3001" });
		server.middlewares.use((req, res, next) => {
			if (toApi.test(req.url ?? "")) proxy.web(req, res).catch(next);
			else next();
		});
	},
});

const config = defineConfig({
	envDir: "../..",
	resolve: { tsconfigPaths: true },
	plugins: [
		apiProxy(),
		devtools(),
		paraglideVitePlugin({
			project: "./project.inlang",
			outdir: "./src/paraglide",
			strategy: ["cookie", "baseLocale"],
		}),
		nitro({
			rollupConfig: { external: [/^@sentry\//] },
			plugins: ["./src/server/bootstrap.ts"],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact(),
		babel({ presets: [reactCompilerPreset()] }),
	],
});

export default config;
