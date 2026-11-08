import { expect, test } from "bun:test";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";
import type { CodeSdkOptions } from "./types";

const options: CodeSdkOptions = { mode: "resource", owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner-shop" } } };
function analyze(source: string, mode = options) {
  const fixture = sdkFixture();
  fixture.events![0]!.place = "workshop";
  return analyzeCode({
    files: { "code.ts": `import { app, owner, work_shop } from "@sdk";\n${source}\nexport default app;` },
    entry: "code.ts",
    aiOperations: [],
    sdk: generateCodeSdk([fixture], mode),
  });
}
test("app.on records the exact event version, owner place and handler permissions", () => {
  const result = analyze('app.on("work-shop.changed", async event => { await owner.stock.list({}); });');
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints).toEqual([
    {
      kind: "event",
      entrypoint: "event:work-shop.changed@1",
      cron: null,
      file: "code.ts",
      line: 2,
      event: { type: "work-shop.changed", version: 1, place: { type: "work-shop.workshop", id: "owner-shop" } },
    },
  ]);
  expect(result.permissions).toMatchObject([{ operation: "work-shop.stock.list", entrypoints: ["event:work-shop.changed@1"] }]);
}, 30_000);
test("a foreign place, missing owner or app owner cannot subscribe", () => {
  expect(analyze('app.on(work_shop.workshop("other"), "work-shop.changed", () => {});').diagnostics).toContainEqual(
    expect.objectContaining({ code: "code_event_owner" }),
  );
  expect(analyze('app.on("work-shop.changed", () => {});', { mode: "personal" }).diagnostics).toContainEqual(
    expect.objectContaining({ code: "code_dynamic_event" }),
  );
  expect(
    analyze('app.on("work-shop.changed", () => {});', { mode: "resource", owner: { kind: "app", appId: "work-shop" } }).diagnostics.length,
  ).toBeGreaterThan(0);
}, 30_000);
test("registration must be static and unique", () => {
  expect(analyze('if (Date.now()) app.on("work-shop.changed", () => {});').diagnostics).toContainEqual(
    expect.objectContaining({ code: "code_static_event" }),
  );
  expect(analyze('app.on("work-shop.changed", () => {}); app.on(owner, "work-shop.changed", () => {});').diagnostics).toContainEqual(
    expect.objectContaining({ code: "code_duplicate_on" }),
  );
}, 30_000);
