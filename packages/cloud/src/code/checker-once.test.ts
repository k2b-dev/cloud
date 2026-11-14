import { expect, test } from "bun:test";
import { CodeCheckedVersionManifestSchema, CodeVersionEntrypointSchema } from "../contracts/code-version";
import { analyzeCode } from "./checker-analysis";
import { CodeVersionManifestSchema } from "./checker-contract";
import { generateCodeSdk } from "./generator";

const sdk = generateCodeSdk([], { mode: "personal" });
const analyze = (when: string, files: Record<string, string> = {}) =>
  analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      ...files,
      "code.ts": `import { app } from "@sdk";\napp.schedule(${when.replace("{", '{ name: "reminder", title: "Send summary",')}, async () => {});\nexport default app;`,
    },
  });
const once = { at: "2026-12-01T09:15:30+01:00", timeZone: "Europe/Berlin" };

test("checker preserves a constant one-time instant, zone, entrypoint and title", () => {
  const result = analyze(JSON.stringify(once));
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints).toEqual([
    { kind: "schedule", entrypoint: "reminder", title: "Send summary", cron: null, ...once, file: "code.ts", line: 2 },
  ]);
  const entry = result.entrypoints[0]!;
  expect(CodeVersionEntrypointSchema.parse(entry)).toEqual(entry);
  const manifest = {
    version: 1,
    entrypoints: result.entrypoints,
    permissions: [],
    ai: false,
    hashes: { source: "a".repeat(64), sdk: "b".repeat(64), bundle: "c".repeat(64) },
  };
  expect(CodeVersionManifestSchema.safeParse(manifest).success).toBeTrue();
  expect(CodeCheckedVersionManifestSchema.safeParse({ ...manifest, entry: "code.ts", policyRows: [] }).success).toBeTrue();
});

test("checker accepts an imported constant one-time declaration", () => {
  const result = analyzeCode({
    sdk,
    entry: "code.ts",
    aiOperations: [],
    files: {
      "timing.ts": `export const timing = ${JSON.stringify({ ...once, name: "reminder" })} as const;`,
      "code.ts": 'import { app } from "@sdk"; import { timing } from "./timing"; app.schedule(timing, async () => {}); export default app;',
    },
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.entrypoints[0]).toMatchObject({ cron: null, ...once });
});

test.each([
  '{ at: new Date().toISOString(), timeZone: "UTC" }',
  '{ at: "2026-02-30T09:00:00Z", timeZone: "UTC" }',
  '{ at: "2026-12-01T09:00:00" , timeZone: "Europe/Berlin" }',
  '{ at: "2026-12-01T09:00:00Z", timeZone: "Mars/Olympus" }',
  '{ at: "2026-12-01T09:00:00Z", timeZone: "UTC", cron: "* * * * *" }',
  '{ at: "2026-12-01T09:00+01:00", timeZone: "Europe/Berlin" }',
])("checker rejects invalid one-time timing %s", (when) => {
  expect(analyze(when).diagnostics).toContainEqual(expect.objectContaining({ code: "code_static_schedule" }));
});

test("manifest refuses ambiguous once/cron timing and incomplete one-time metadata", () => {
  const entry = { kind: "schedule", entrypoint: "reminder", file: "code.ts", line: 1, cron: null, ...once };
  for (const invalid of [
    { ...entry, cron: "0 9 * * *" },
    { ...entry, at: undefined },
    { ...entry, kind: "manual" },
  ]) {
    expect(CodeVersionEntrypointSchema.safeParse(invalid).success).toBeFalse();
  }
});

test("runner SDK registers once and cron handlers without starting either during module loading", async () => {
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
  let executions = 0;
  runtime.app.schedule({ ...once, name: "reminder", title: "Send summary" }, () => {
    executions++;
  });
  runtime.app.schedule({ cron: "0 8 * * 1", name: "weekly" }, () => {
    executions++;
  });
  expect(executions).toBe(0);
  expect(runtime.__codeSdk.entries()).toEqual([
    { kind: "schedule", entrypoint: "reminder", title: "Send summary", cron: null, ...once },
    { kind: "schedule", entrypoint: "weekly", cron: "0 8 * * 1" },
  ]);
  await runtime.__codeSdk.run("reminder");
  expect(executions).toBe(1);
  for (const timing of [
    { ...once, timeZone: "Mars/Olympus" },
    { ...once, at: "tomorrow" },
    { ...once, at: "2026-12-01T09:15+01:00" },
    { ...once, at: "2026-02-30T09:00:00Z" },
    { ...once, cron: "* * * * *" },
  ]) {
    expect(() => runtime.app.schedule({ ...timing, name: "invalid" }, () => {})).toThrow("code_sdk_invalid_schedule");
  }
});
