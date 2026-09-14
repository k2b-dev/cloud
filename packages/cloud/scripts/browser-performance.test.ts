import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEB_VITALS_ASSET_HREF, WEB_VITALS_ASSET_NAME } from "../src/_internal/web-vitals-asset";
import { CORE_SETTINGS } from "../src/services/settings/core-settings";
import { buildBrowserPerformance } from "./browser-performance";

test("only Core builds the shared collector and server bundles preserve its URL without source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-vitals-review-"));
  try {
    expect(CORE_SETTINGS["observability.web_vitals.enabled"].default).toBe(false);
    await buildBrowserPerformance(root, "mail");
    await buildBrowserPerformance(root, "spaces");
    expect(await readdir(root)).toEqual([]);
    await buildBrowserPerformance(root, "core");
    expect(await readdir(root)).toEqual([WEB_VITALS_ASSET_NAME]);
    expect(await Bun.file(join(root, WEB_VITALS_ASSET_NAME)).text()).toContain("/api/me/web-vitals");
    const entry = join(root, "entry.ts");
    await Bun.write(
      entry,
      `import {WEB_VITALS_ASSET_HREF} from ${JSON.stringify(join(import.meta.dir, "../src/_internal/web-vitals-asset.ts"))}; console.log(WEB_VITALS_ASSET_HREF);`,
    );
    const result = await Bun.build({ entrypoints: [entry], outdir: join(root, "bundled"), target: "bun", minify: true });
    expect(result.success).toBe(true);
    await rm(entry);
    const process = Bun.spawn([Bun.which("bun")!, join(root, "bundled/entry.js")], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(await process.exited).toBe(0);
    expect((await new Response(process.stdout).text()).trim()).toBe(WEB_VITALS_ASSET_HREF);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
