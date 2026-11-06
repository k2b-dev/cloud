import { expect, test } from "bun:test";
import { appFrameAssets, checkFrameAssets } from "./assets";
import { buildCheckPrelude, buildPrelude } from "./build-assets";

test("normal mounts omit app checks and stay within the prelude budget", async () => {
  const [normal, check] = await Promise.all([buildPrelude(), buildCheckPrelude()]);
  // Offline frames include all chart renderers synchronously. Before the bars family the prelude was 299.8 KB;
  // grouped/stacked/compared bars, hbar and their validation add 15.4 KB (8.1 KB bar drawing, 4.1 KB hbar).
  // Keep 10% headroom above the measured 315.2 KB, independently of the much larger app-check bundle.
  expect(Buffer.byteLength(normal)).toBeLessThan(315_200 * 1.1);
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
}, 30000);
