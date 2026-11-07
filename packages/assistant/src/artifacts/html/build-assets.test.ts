import { expect, test } from "bun:test";
import { appFrameAssets, checkFrameAssets } from "./assets";
import { buildCheckPrelude, buildPrelude } from "./build-assets";

test("normal mounts omit app checks and stay within the prelude budget", async () => {
  const [normal, check] = await Promise.all([buildPrelude(), buildCheckPrelude()]);
  // Slice 3 measured 248 KB. cloud.chart() drawing through the chat's chart mapping, with four more chart kinds and
  // its app contract, brought normal mounts to 279 KB: allow 10% growth over that, not the 851 KB app-check bundle.
  // Stacked/100 % area adds 12,292 bytes to the measured 299,838-byte main prelude. Reserve 13 KB for this
  // synchronous renderer, validation and tooltip support, retaining the existing headroom for other changes.
  expect(Buffer.byteLength(normal)).toBeLessThan(279_000 * 1.1 + 13_000);
  expect(normal).toContain("k2b-area-layer");
  // Reference cells need only the resource identity schema, not capability registration and mail contracts.
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

test("check assets pin their own prelude and share the normal base stylesheet", async () => {
  const [normal, check] = await Promise.all([appFrameAssets(), checkFrameAssets()]);
  expect(normal.preludeHash).toBe(`'sha256-${new Bun.CryptoHasher("sha256").update(normal.prelude).digest("base64")}'`);
  expect(check.preludeHash).toBe(`'sha256-${new Bun.CryptoHasher("sha256").update(check.prelude).digest("base64")}'`);
  expect(check.preludeHash).not.toBe(normal.preludeHash);
  expect(check.prelude).toContain("axe-core");
  expect(normal.prelude).not.toContain("axe-core");
  expect(check.baseCss).toBe(normal.baseCss);
}, 30000);
