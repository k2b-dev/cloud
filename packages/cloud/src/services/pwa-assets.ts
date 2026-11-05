import { RESOURCE_ACCESS_ENTRY_TIMEOUT_MS } from "../_internal/app-access-resources";
import { listApps } from "../_internal/registry";
import { isPwaStaticAsset, PWA_ASSET_MANIFEST_PATH, type PwaStaticAsset } from "../contracts/pwa-assets";
import { logger } from "./logging";

const log = logger("pwa-assets");

/**
 * The shell embeds this live build catalog into its network-only worker source. No browser metadata is trusted. An app
 * whose catalog cannot be read or is invalid is left out, so its files load from the network until the next worker
 * update; one restarting app never blocks the worker or keeps an earlier catalog alive.
 */
export async function pwaStaticAssets(): Promise<PwaStaticAsset[]> {
  const apps = (await listApps()).filter((app) => app.id === "core" || app.id === "pwa" || app.pwa);
  const assets: PwaStaticAsset[] = [];
  // Sequential reads bound fan-out to one internal request. The shared entry budget also bounds the whole catalog.
  const signal = AbortSignal.timeout(RESOURCE_ACCESS_ENTRY_TIMEOUT_MS);
  for (const app of apps.sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      const response = await fetch(new URL(PWA_ASSET_MANIFEST_PATH, app.baseUrl), { signal, redirect: "error", cache: "no-store" });
      // Older application versions do not participate until rebuilt.
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`status ${response.status}`);
      const manifest: unknown = await response.json();
      if (!Array.isArray(manifest) || !manifest.every(isPwaStaticAsset)) throw new Error("invalid catalog");
      assets.push(...manifest);
    } catch (error) {
      log.warn("Cloud app static asset catalog left out", { app: app.id, error: error instanceof Error ? error.message : "unknown" });
    }
  }
  return assets.sort((a, b) => a.url.localeCompare(b.url));
}
