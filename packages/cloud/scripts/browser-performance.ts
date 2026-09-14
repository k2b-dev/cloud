import { resolve } from "node:path";
import { WEB_VITALS_ASSET_NAME } from "../src/_internal/web-vitals-asset";

export async function buildBrowserPerformance(publicDir: string, appId: string): Promise<void> {
  if (appId !== "core") return;
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/browser/web-vitals.ts")],
    outdir: publicDir,
    naming: WEB_VITALS_ASSET_NAME,
    target: "browser",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Browser performance build failed");
}
