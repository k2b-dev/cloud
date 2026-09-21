import type { AppRuntimeMetadata } from "../contracts/registry";

declare const __CLOUD_VERSION__: string;
declare const __CLOUD_RELEASE__: string;
declare const __CLOUD_SYNC_VERSION__: string;

/** Cloud version and release label baked into the bundle by `scripts/build.ts`. */
export const buildMetadata = {
  version: typeof __CLOUD_VERSION__ === "string" ? __CLOUD_VERSION__ : "0.0.0-local",
  release: typeof __CLOUD_RELEASE__ === "string" ? __CLOUD_RELEASE__ : "development",
} as const;

export const appRuntimeMetadata: AppRuntimeMetadata = {
  ...buildMetadata,
  syncVersion: typeof __CLOUD_SYNC_VERSION__ === "string" ? __CLOUD_SYNC_VERSION__ : "unknown",
};
