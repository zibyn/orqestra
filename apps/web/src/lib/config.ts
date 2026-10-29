import { loadConfig } from "@orqestra/config";

// Loaded once per process; config changes need a restart
export const config = loadConfig();
