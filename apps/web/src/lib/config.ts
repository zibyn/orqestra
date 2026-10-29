import { liveConfig } from "@orqestra/config/live";

// Reloaded whenever an Admin saves Providers or Models; Agent Definition file changes still need a restart
export const config = liveConfig();
