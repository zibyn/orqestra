import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { paraglideVitePlugin } from '@inlang/paraglide-js'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'
import { config as loadEnv } from 'dotenv'

// .env lives at the repo root; Start only loads env from the Vite root
loadEnv({ path: ['../../.env.local', '../../.env'], quiet: true })

const config = defineConfig({
  envDir: '../..',
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/paraglide',
      strategy: ['cookie', 'baseLocale'],
    }),
    nitro({
      rollupConfig: { external: [/^@sentry\//] },
      plugins: ['./src/server/bootstrap.ts'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
})

export default config
