/**
 * Core re-exports the platform settings so `defineApp({ settings })` keeps its
 * literal-type inference. The definitions themselves live in the framework —
 * every container has to register them, not just the one that renders the UI.
 */
import { CORE_SETTINGS as PLATFORM_SETTINGS } from "@k2b/cloud/services/settings/core-settings";
import { CODE_SETTINGS } from "./code/settings";

export const CORE_SETTINGS = { ...PLATFORM_SETTINGS, ...CODE_SETTINGS } as const;
