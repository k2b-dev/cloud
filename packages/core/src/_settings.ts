/**
 * Core re-exports the platform settings so `defineApp({ settings })` keeps its
 * literal-type inference. The definitions themselves live in the framework —
 * every container has to register them, not just the one that renders the UI.
 */
export { CORE_SETTINGS } from "@k2b/cloud/services/settings/core-settings";
