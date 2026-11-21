import { expect, test } from "bun:test";
import { CodeCheckedVersionManifestSchema, CodeVersionEntrypointSchema } from "../contracts/code-version";
import { analyzeCode } from "./checker-analysis";
import { generateCodeSdk } from "./generator";
import { sdkFixture } from "./sdk.test-fixture";

const sdk = generateCodeSdk([], { mode: "personal" });
const source = (when: string) => `import { app } from "@sdk"; app.schedule(${when}, async () => {}); export default app;`;
const analyze = (when: string) => analyzeCode({ sdk, entry: "code.ts", aiOperations: [], files: { "code.ts": source(when) } });

test("recurring schedule preserves its constant zone and inline name in the checked manifest", () => {
  const checked = analyze('{ cron: "0 9 * * *", timeZone: "Europe/Berlin", name: "morning" }');
  expect(checked.diagnostics).toEqual([]);
  expect(checked.entrypoints).toEqual([
    { kind: "schedule", entrypoint: "morning", cron: "0 9 * * *", timeZone: "Europe/Berlin", file: "code.ts", line: 1 },
  ]);
  expect(
    CodeCheckedVersionManifestSchema.parse({
      version: 1,
      entry: "code.ts",
      entrypoints: checked.entrypoints,
      permissions: [],
      ai: false,
      policyRows: [],
      hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
    }).entrypoints,
  ).toEqual(checked.entrypoints);
});

test("imported const timing and omitted zone remain valid; the old string form is refused", () => {
  const checked = analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      "timing.ts": 'export const timing = { cron: "0 9 * * *", timeZone: "Europe/Berlin", name: "morning" } as const;',
      "code.ts": 'import { app } from "@sdk"; import { timing } from "./timing"; app.schedule(timing, async () => {}); export default app;',
    },
  });
  expect(checked.diagnostics).toEqual([]);
  expect(checked.entrypoints[0]).toMatchObject({ entrypoint: "morning", timeZone: "Europe/Berlin" });
  expect(analyze('{ cron: "0 9 * * *", name: "morning" }').entrypoints[0]).toMatchObject({ cron: "0 9 * * *" });
  expect(analyze('"0 9 * * *"').diagnostics).toContainEqual(expect.objectContaining({ code: "code_static_schedule" }));
  expect(
    CodeVersionEntrypointSchema.safeParse({ kind: "schedule", entrypoint: "old", cron: "0 9 * * *", file: "code.ts", line: 1 }).success,
  ).toBeTrue();
});

test.each([
  '{ cron: "0 9 * * *", timeZone: "Mars/Olympus", name: "morning" }',
  '{ cron: "0 9 * * *", timeZone: "", name: "morning" }',
  '{ cron: "bad", timeZone: "UTC", name: "morning" }',
  '{ cron: "0 9 * * *", timeZone: new Date().toISOString(), name: "morning" }',
  '{ cron: "0 9 * * *", timeZone: "UTC", at: "2026-12-01T00:00:00Z", name: "morning" }',
  '{ cron: "0 9 * * *", timeZone: "UTC", name: String(Date.now()) }',
])("checker refuses invalid or dynamic recurring declaration %s", (when) => {
  expect(analyze(when).diagnostics.length).toBeGreaterThan(0);
});

test("schedule declaration remains at module level", () => {
  const checked = analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      "code.ts":
        'import { app } from "@sdk"; function setup() { app.schedule({ cron: "0 9 * * *", timeZone: "Europe/Berlin", name: "morning" }, async () => {}); } setup(); export default app;',
    },
  });
  expect(checked.diagnostics).toContainEqual(expect.objectContaining({ code: "code_static_schedule" }));
});

test("runner SDK carries recurring zone/name and runs only the selected handler", async () => {
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  let count = 0;
  runtime.app.schedule({ cron: "0 9 * * *", timeZone: "Europe/Berlin", name: "morning" }, () => {
    count++;
  });
  expect(count).toBe(0);
  expect(runtime.__codeSdk.entries()).toEqual([{ kind: "schedule", entrypoint: "morning", cron: "0 9 * * *", timeZone: "Europe/Berlin" }]);
  await runtime.__codeSdk.run("morning");
  expect(count).toBe(1);
  expect(() => runtime.app.schedule({ cron: "0 9 * * *", timeZone: "Mars/Olympus", name: "invalid" }, () => {})).toThrow(
    "invalid_schedule",
  );
});

test("an event registered before a zoned schedule preserves its kind and the schedule's index", async () => {
  const fixture = sdkFixture();
  fixture.events![0]!.place = "workshop";
  const resourceSdk = generateCodeSdk([fixture], {
    mode: "resource",
    owner: { kind: "resource", ref: { type: "work-shop.workshop", id: "owner-shop" } },
  });
  const checked = analyzeCode({
    sdk: resourceSdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      "code.ts": `import { app } from "@sdk";
app.on("work-shop.changed", () => {});
app.schedule({ name: "schedule-0", cron: "0 9 * * *", timeZone: "Europe/Berlin" }, () => {});
export default app;`,
    },
  });
  expect(checked.diagnostics).toEqual([]);
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(resourceSdk.runtime).toString("base64")}`);
  let calls = 0;
  runtime.app.on("work-shop.changed", () => {});
  runtime.app.schedule({ name: "schedule-0", cron: "0 9 * * *", timeZone: "Europe/Berlin" }, () => calls++);
  expect(runtime.__codeSdk.entries()).toEqual(checked.entrypoints.map(({ file: _file, line: _line, ...entry }) => entry));
  expect(runtime.__codeSdk.entries()[1]).toMatchObject({
    kind: "schedule",
    entrypoint: "schedule-0",
    timeZone: "Europe/Berlin",
  });
  await runtime.__codeSdk.run("schedule-0");
  expect(calls).toBe(1);
});
