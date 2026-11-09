import { definePlugin } from "nitro";
// Validates the env vars at startup rather than on the first request; the api checks the live config
import "#/env";

export default definePlugin(() => {});
