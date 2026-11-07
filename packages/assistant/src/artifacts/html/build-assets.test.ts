import { expect, test } from "bun:test";
import { appFrameAssets, checkFrameAssets } from "./assets";
import { buildChartModule, buildCheckPrelude, buildPrelude } from "./build-assets";

test("normal mounts omit app checks and stay within the prelude budget", async () => {
  const [normal, check] = await Promise.all([buildPrelude(), buildCheckPrelude()]);
  // Rare renderers belong to the separate offline module, never to every app's prelude.
  // Previous main budget was 319,900 B; keep the common frame below it without per-kind raises.
  expect(normal).not.toContain("k2b-area-layer");
  const rare = await buildChartModule();
  // The separate module travels in every srcdoc; each intermediate kind keeps about 1% headroom.
  expect(rare).toContain("k2b-area-layer");
  expect(normal).not.toContain("data-calendar-weekdays");
  expect(rare).toContain("data-calendar-weekdays");
  for (const marker of ["k2b-chart-pareto-current", "k2b-chart-treemap-cell"]) {
    expect(normal).not.toContain(marker);
    expect(rare).toContain(marker);
  }
  // The blob must be self-contained: no module can fetch a dependency on first use.
  expect(rare).not.toMatch(/\bimport\s*(?:\(|["'{*])/);
  console.info(`App prelude: ${Buffer.byteLength(normal)} B; offline chart module: ${Buffer.byteLength(rare)} B`);
  expect(Buffer.byteLength(normal)).toBeLessThan(319_900);
  // temporary until the last kind PR sets the catalog total, see #2790
  expect(Buffer.byteLength(rare)).toBeLessThan(60_400);
  // The frame imports `@k2b/cloud/ai/app-frame`: the `ai/browser` barrel kept its skill parser and YAML (34 KB).
  expect(normal).not.toContain("tag:yaml.org,2002:");
  expect(normal).not.toMatch(/axe\.run|axe-core|axeVersion/);
  expect(normal).not.toContain("check-result");
  expect(normal).not.toMatch(/type\s*[!=]==?\s*["']check["']/);
  expect(check).toContain("axe-core");
  expect(check).toContain("check-result");
  expect(check).toMatch(/type\s*[!=]==?\s*["']check["']/);
  expect(Buffer.byteLength(check)).toBeGreaterThan(Buffer.byteLength(normal));
}, 30000);

test("check assets pin their own prelude and share the normal base stylesheet", async () => {
  const [normal, check] = await Promise.all([appFrameAssets(), checkFrameAssets()]);
  expect(normal.preludeHash).toBe(`'sha256-${new Bun.CryptoHasher("sha256").update(normal.prelude).digest("base64")}'`);
  expect(check.preludeHash).toBe(`'sha256-${new Bun.CryptoHasher("sha256").update(check.prelude).digest("base64")}'`);
  expect(check.preludeHash).not.toBe(normal.preludeHash);
  expect(check.prelude).toContain("axe-core");
  expect(normal.prelude).not.toContain("axe-core");
  expect(check.baseCss).toBe(normal.baseCss);
  expect(check.chartModule).toBe(normal.chartModule);
  expect(normal.chartModule).toContain("k2b-area-layer");
}, 30000);
