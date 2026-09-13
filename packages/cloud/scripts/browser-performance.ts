import { resolve } from "node:path";

export async function buildBrowserPerformance(publicDir: string, appId: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/browser/web-vitals.ts")],
    outdir: resolve(publicDir, appId),
    naming: "web-vitals.js",
    target: "browser",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Browser performance build failed");
}
