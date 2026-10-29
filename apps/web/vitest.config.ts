import { defineConfig } from "vitest/config";

// Keeps tests off vite.config.ts, whose Start/nitro plugins keep the process alive
export default defineConfig({});
