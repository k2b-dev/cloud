import type { AppRegistryEntry } from "./registry";

/** Unnamed development builds do not identify a release. */
export const pwaBuild = (runtime: { release: string; version?: string } | undefined): string | undefined =>
  runtime && !["", "development", "local"].includes(runtime.release) ? `${runtime.version ?? ""}:${runtime.release}` : undefined;

/** Only page owners and Core's shared assets can change a mobile document. */
export const pwaBuilds = (apps: readonly AppRegistryEntry[]): Record<string, string> =>
  Object.fromEntries(
    apps.flatMap((app) => {
      const build = pwaBuild(app.runtime);
      return build && (app.id === "core" || app.id === "pwa" || app.pwa) ? [[app.id, build]] : [];
    }),
  );
