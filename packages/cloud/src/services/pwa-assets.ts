import { RESOURCE_ACCESS_ENTRY_TIMEOUT_MS } from "../_internal/app-access-resources";
import { listApps } from "../_internal/registry";
import { isPwaStaticAsset, PWA_ASSET_MANIFEST_PATH, type PwaStaticAsset } from "../contracts/pwa-assets";

/** The shell embeds this live build catalog into its network-only worker source. No browser metadata is trusted. */
export async function pwaStaticAssets(): Promise<PwaStaticAsset[]> {
  const apps = (await listApps()).filter((app) => app.id === "core" || app.id === "pwa" || app.pwa);
  const assets: PwaStaticAsset[] = [];
  // Sequential reads bound fan-out to one internal request. The shared entry budget also bounds the whole catalog.
  const signal = AbortSignal.timeout(RESOURCE_ACCESS_ENTRY_TIMEOUT_MS);
  for (const app of apps.sort((a, b) => a.id.localeCompare(b.id))) {
    const response = await fetch(new URL(PWA_ASSET_MANIFEST_PATH, app.baseUrl), { signal, redirect: "error", cache: "no-store" });
    // Older application versions do not participate until rebuilt. Never retain an earlier catalog on failure.
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`Cannot read static build assets for ${app.id}`);
    const manifest: unknown = await response.json();
    if (!Array.isArray(manifest) || !manifest.every(isPwaStaticAsset)) throw new Error(`Invalid static build assets for ${app.id}`);
    assets.push(...manifest);
  }
  return assets.sort((a, b) => a.url.localeCompare(b.url));
}
