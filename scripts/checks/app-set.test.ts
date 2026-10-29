import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rule } from "./app-set";

const root = resolve(import.meta.dir, "../..");
test("generated built-in app IDs and Compose services agree with the workspace", async () => {
  expect(await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).toEqual([]);
});
test("app-set rejects drift in the generated built-in app IDs", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "app-set-"));
  try {
    mkdirSync(join(fixture, "packages/cloud/src/config"), { recursive: true });
    mkdirSync(join(fixture, ".github/workflows"), { recursive: true });
    const files = ["package.json", "compose.dev.yml", "compose.prod.yml", "packages/cloud/src/config/built-in-apps.ts"];
    for (const file of files) writeFileSync(join(fixture, file), readFileSync(join(root, file)));
    const changed = "packages/cloud/src/config/built-in-apps.ts";
    const source = readFileSync(join(fixture, changed), "utf8");
    writeFileSync(join(fixture, changed), source.replace('  "chat",', '  "chta",'));
    const findings = await rule.run({ workspaceRoot: fixture, fix: false, flags: new Set() });
    expect(findings.some((finding) => finding.message.includes("missing chat"))).toBe(true);
    expect(findings.some((finding) => finding.message.includes("chta"))).toBe(true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
