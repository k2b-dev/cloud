import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule } from "./event-place-exception";

test("only the defining module and Code's event-place check may name eventPlace, in any spelling", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "cloud-event-place-exception-"));
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: workspaceRoot }).exitCode).toBe(0);
  const write = async (path: string, source: string) => {
    await mkdir(join(workspaceRoot, path, ".."), { recursive: true });
    await writeFile(join(workspaceRoot, path), source);
  };
  expect(await rule.run({ workspaceRoot, fix: false, flags: new Set() })).toEqual([]);
  await write("packages/cloud/src/capabilities/resource-readers.ts", "type O = { eventPlace: true };");
  await write("packages/core/src/code/event-access.ts", "read({ ref, eventPlace: true });");
  await write("packages/chat/src/reads.test.ts", "read({ eventPlace: true });");
  await write("docs-site/docs/en/page.md", "`eventPlace: true`");
  expect(await rule.run({ workspaceRoot, fix: false, flags: new Set() })).toEqual([]);
  await write("packages/chat/src/shorthand.ts", "const eventPlace = true as const;\nread({ eventPlace });");
  await write("packages/notes/src/quoted.ts", 'read({ "eventPlace": true });');
  await write("scripts/helper.ts", "read({ ...input, eventPlace: true });");
  const findings = await rule.run({ workspaceRoot, fix: false, flags: new Set() });
  expect(findings.map((finding) => `${finding.file}:${finding.line}`).sort()).toEqual([
    "packages/chat/src/shorthand.ts:1",
    "packages/chat/src/shorthand.ts:2",
    "packages/notes/src/quoted.ts:1",
    "scripts/helper.ts:1",
  ]);
});
