// Test helper: the app frame assets as the /app-assets routes serve them, built once per test process.
import { buildBaseCss, buildPrelude } from "./build-assets";

let assets: Promise<string> | undefined;
export function appAssetsJson(): Promise<string> {
  assets ??= Promise.all([buildPrelude(), buildBaseCss()]).then(([prelude, baseCss]) =>
    JSON.stringify({ prelude, preludeHash: `'sha256-${new Bun.CryptoHasher("sha256").update(prelude).digest("base64")}'`, baseCss }),
  );
  return assets;
}
/** Serves the routes every app mount reads: frame assets and the viewer context. */
export async function appRuntimeRoute(path: string): Promise<Response | undefined> {
  if (path.endsWith("/app-assets")) return new Response(await appAssetsJson(), { headers: { "content-type": "application/json" } });
  if (path === "/api/assistant/artifacts/runtime/context") return Response.json({ locale: "en-US", timeZone: "UTC", user: null });
  return undefined;
}
/** An app document as Studio stores it. */
export const htmlApp = (body: string, script = "") => ({
  entry: "index.html",
  files: [{ path: "index.html", content: `<main>${body}</main>` }, ...(script ? [{ path: "app.js", content: script }] : [])],
});
