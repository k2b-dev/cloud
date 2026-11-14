// Test helper: the app frame assets as the /app-assets routes serve them, built once per test process.

import { AppFrameAsset } from "./asset-schemas";
import { frameAssetPayload } from "./assets";
import { buildBaseCss, buildChartParts, buildPrelude } from "./build-assets";

let assets: Promise<string> | undefined;
export function appAssetsJson(): Promise<string> {
  assets ??= Promise.all([buildPrelude(), buildBaseCss(), buildChartParts()]).then(([prelude, baseCss, chartParts]) =>
    JSON.stringify({
      prelude,
      preludeHash: `'sha256-${new Bun.CryptoHasher("sha256").update(prelude).digest("base64")}'`,
      baseCss,
      chartParts,
    }),
  );
  return assets;
}
/** Serves the routes every app mount reads: frame assets and the viewer context. */
export async function appRuntimeRoute(path: string): Promise<Response | undefined> {
  if (path.endsWith("/app-assets") || path.endsWith("/chart-parts")) return appAssetResponse(await appAssetsJson(), path);
  if (path === "/api/assistant/artifacts/runtime/context") return Response.json({ locale: "en-US", timeZone: "UTC", user: null });
  return undefined;
}
/** Split transport used by the interactive host; the source fixture still includes all offline parts. */
export function appAssetResponse(source: string, path: string): Response {
  const assets = AppFrameAsset.parse(JSON.parse(source));
  return Response.json(path.endsWith("/chart-parts") ? { chartParts: assets.chartParts } : frameAssetPayload(assets));
}
/** An app document as Studio stores it. */
export const htmlApp = (body: string, script = "") => ({
  entry: "index.html",
  files: [{ path: "index.html", content: `<main>${body}</main>` }, ...(script ? [{ path: "app.js", content: script }] : [])],
});
