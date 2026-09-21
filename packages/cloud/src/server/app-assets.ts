import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../config/env";

/** Set by `scripts/build.ts`; the bundle lives next to `dist/assets/`. */
declare const __CLOUD_APP_ASSETS__: string | undefined;

const assetsRoot = (): string =>
  typeof __CLOUD_APP_ASSETS__ === "string"
    ? fileURLToPath(new URL(__CLOUD_APP_ASSETS__, import.meta.url))
    : resolve(env.APP_DIR ?? process.cwd(), "src/assets");

/**
 * Absolute path of a server-side application asset.
 *
 * Applications keep files their server reads at runtime (document templates,
 * seed data, binaries) under `src/assets/`. The production build copies that
 * directory to `dist/assets/`, so the same call works from the source tree
 * (`APP_DIR`, or the working directory, plus `src/assets`) and from the
 * bundled image. The path must stay inside the assets directory.
 */
export function appAssetPath(...segments: string[]): string {
  const root = assetsRoot();
  const path = resolve(root, ...segments);
  if (path !== root && !path.startsWith(root + sep)) throw new Error(`Asset path escapes src/assets: ${segments.join("/")}`);
  return path;
}
