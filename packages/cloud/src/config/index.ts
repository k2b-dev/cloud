/**
 * Main config export.
 * Re-exports the platform environment registry and the registry factory used
 * by application `src/env.ts` files. SSR config is per-app via defineApp().
 */

export { defineEnv, type EnvRegistry, type EnvScope, type EnvSpec, type EnvSpecs, envBoolean, envList, envString } from "./define-env";
export { env } from "./env";
