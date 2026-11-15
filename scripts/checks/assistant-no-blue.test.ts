import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blueClasses, rule } from "./assistant-no-blue";

test("finds fixed blue utility classes with their variants and opacity", () => {
  const source = [
    '<a class="font-medium hover:text-blue-600 dark:hover:text-blue-400">',
    '<span class="bg-blue-50/60 ring-blue-500">',
    '<span class="text-[var(--k2b-action)] text-primary">',
    "const tone = 'bluebird-500 blue-ish';",
  ].join("\n");
  expect(blueClasses(source)).toEqual([
    { line: 1, match: "hover:text-blue-600" },
    { line: 1, match: "dark:hover:text-blue-400" },
    { line: 2, match: "bg-blue-50/60" },
    { line: 2, match: "ring-blue-500" },
  ]);
});

test("reports Assistant sources and ignores tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-no-blue-"));
  const frontend = join(root, "packages/assistant/src/frontend");
  await mkdir(frontend, { recursive: true });
  await writeFile(join(frontend, "Panel.tsx"), '<p class="text-blue-600">x</p>\n');
  await writeFile(join(frontend, "Panel.test.tsx"), '<p class="text-blue-600">x</p>\n');
  try {
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => [finding.file, finding.line])).toEqual([["packages/assistant/src/frontend/Panel.tsx", 1]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
