import { expect, test } from "bun:test";
import type { RareChart } from "../runtime/chart-renderer-types";
import { appFrameAssets, ChartPartsAsset, checkFrameAssets, frameAssetPayload } from "./assets";
import { buildChartParts, buildCheckPrelude, buildPrelude } from "./build-assets";
import { CHART_SHARED_IMPORT, chartHashes } from "./chart-parts";
import { moduleSpecifiers } from "./imports";

test("interactive frame assets carry chart hashes without chart source", async () => {
  const assets = await appFrameAssets();
  const payload = frameAssetPayload(assets);
  expect(payload).toEqual({
    prelude: assets.prelude,
    preludeHash: assets.preludeHash,
    baseCss: assets.baseCss,
    chartHashes: chartHashes(assets.chartParts),
  });
  expect(JSON.stringify(payload)).not.toContain('"chartParts"');
  expect(JSON.stringify(payload)).not.toContain("k2b-area-layer");
});

test("normal mounts omit app checks and stay within the prelude budget", async () => {
  const [normal, check] = await Promise.all([buildPrelude(), buildCheckPrelude()]);
  // Rare renderers belong to the separate offline module, never to every app's prelude.
  // Previous main budget was 319,900 B; keep the common frame below it without per-kind raises.
  expect(normal).not.toContain("k2b-area-layer");
  const parts = await buildChartParts();
  const rare =
    parts.shared.code +
    Object.values(parts.kinds)
      .map((part) => part.code)
      .join("\n");
  // Only requested kind assets and shared helpers enter a frame over its host channel.
  expect(rare).toContain("k2b-area-layer");
  expect(normal).not.toContain("k2b-waterfall-bar");
  expect(rare).toContain("k2b-waterfall-bar");
  expect(normal).toContain("Waterfall balances must be finite");
  expect(rare).not.toContain("Waterfall balances must be finite");
  expect(normal).not.toContain("data-calendar-weekdays");
  expect(rare).toContain("data-calendar-weekdays");
  for (const marker of ["k2b-chart-bubble-label", "k2b-chart-radar-axis", "k2b-chart-pareto-current", "k2b-chart-treemap-cell"]) {
    expect(normal).not.toContain(marker);
    expect(rare).toContain(marker);
  }
  // Dependencies are restricted to the one local shared blob; never an external URL.
  expect(parts.shared.code).not.toMatch(/\bimport\s*(?:\(|["'{*])/);
  for (const part of Object.values(parts.kinds)) {
    expect([...moduleSpecifiers(part.code)].map((specifier) => specifier.value)).toEqual([CHART_SHARED_IMPORT]);
  }
  const sizes = Object.fromEntries(Object.entries(parts.kinds).map(([kind, part]) => [kind, Buffer.byteLength(part.code)]));
  const shared = Buffer.byteLength(parts.shared.code);
  const total = shared + Object.values(sizes).reduce((sum, size) => sum + size, 0);
  console.info({ prelude: Buffer.byteLength(normal), shared, kinds: sizes, total });
  expect(Buffer.byteLength(normal)).toBeLessThan(319_900);
  // 8,040 B largest kind, 14,842 B shared, 68,036 B total measured.
  // Coordinator's per-kind allowance; retain the shared and host-total ceilings.
  expect(Math.max(...Object.values(sizes))).toBeLessThanOrEqual(14_500);
  expect(shared).toBeLessThanOrEqual(14_950);
  expect(total).toBeLessThan(68_100);
  const markers = {
    area: "k2b-area-layer",
    waterfall: "k2b-waterfall-bar",
    heatmap: "data-calendar-weekdays",
    bubble: "k2b-chart-bubble-label",
    radar: "k2b-chart-radar-axis",
    pareto: "k2b-chart-pareto-current",
    treemap: "k2b-chart-treemap-cell",
    hbar: "k2b-chart-group-heading",
    funnel: "k2b-chart-funnel",
    histogram: "stdlib-chart-bar stdlib-chart-series-0",
    gauge: "stdlib-chart-gauge-track",
    barGauge: "stdlib-chart-bar-gauge-track",
    boxplot: "stdlib-chart-box-whisker",
    scatter: "stdlib-chart-trendline",
  } satisfies Record<RareChart["kind"], string>;
  expect(Object.keys(parts.kinds).sort()).toEqual(Object.keys(markers).sort());
  for (const [kind, marker] of Object.entries(markers)) {
    expect(normal).not.toContain(marker);
    expect(parts.shared.code).not.toContain(marker);
    for (const [other, part] of Object.entries(parts.kinds)) {
      if (kind === other) expect(part.code).toContain(marker);
      else expect(part.code).not.toContain(marker);
    }
  }
  for (const part of [parts.shared, ...Object.values(parts.kinds)]) {
    expect(part.hash).toBe(new Bun.CryptoHasher("sha256").update(part.code).digest("hex"));
  }

  expect(normal).not.toContain("k2b-chart-group-heading");
  expect(rare).toContain("k2b-chart-group-heading");
  expect(normal).toContain("Horizontal bars require aligned nonnegative segment values");
  expect(rare).not.toContain("Horizontal bars require aligned nonnegative segment values");
  expect(normal).not.toContain("k2b-chart-funnel");
  expect(rare).toContain("k2b-chart-funnel");
  expect(rare).not.toContain(".stdlib-chart-series-0 {");
  expect(normal).not.toContain(".stdlib-chart-series-0 {");
  expect(normal).toContain("Funnel values must be finite and nonnegative, or null");
  expect(rare).not.toContain("Funnel values must be finite and nonnegative, or null");
  // Reference cells need only identity validation, not capability registration.
  expect(normal).not.toContain("Idempotency keys must contain only visible ASCII characters");
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

test("production chart assets validate shared and kind source at the JSON boundary", () => {
  const part = { code: "export const render=()=>'';", hash: "a".repeat(64) };
  expect(ChartPartsAsset.parse({ shared: part, kinds: { histogram: part } })).toEqual({ shared: part, kinds: { histogram: part } });
  for (const value of [
    null,
    { kinds: {} },
    { shared: part },
    { shared: part, kinds: [] },
    { shared: { code: 42, hash: part.hash }, kinds: {} },
    { shared: { code: part.code }, kinds: {} },
    { shared: part, kinds: { histogram: "unhashed" } },
    { shared: part, kinds: { histogram: { code: part.code, hash: "invalid" } } },
  ]) {
    expect(ChartPartsAsset.safeParse(value).success).toBe(false);
  }
});

test("check assets pin their own prelude and share the normal base stylesheet", async () => {
  const [normal, check] = await Promise.all([appFrameAssets(), checkFrameAssets()]);
  expect(normal.preludeHash).toBe(`'sha256-${new Bun.CryptoHasher("sha256").update(normal.prelude).digest("base64")}'`);
  expect(check.preludeHash).toBe(`'sha256-${new Bun.CryptoHasher("sha256").update(check.prelude).digest("base64")}'`);
  expect(check.preludeHash).not.toBe(normal.preludeHash);
  expect(check.prelude).toContain("axe-core");
  expect(normal.prelude).not.toContain("axe-core");
  expect(check.baseCss).toBe(normal.baseCss);
  expect(check.chartParts).toBe(normal.chartParts);
  expect(normal.chartParts.kinds.area!.code).toContain("k2b-area-layer");
}, 30000);
