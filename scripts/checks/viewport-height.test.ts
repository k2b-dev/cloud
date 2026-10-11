import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./viewport-height";

test("rejects large-viewport height classes in package TSX, including variants and dynamic classes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-viewport-height-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/ui"] } }),
      "packages/demo/src/page.tsx": '<main class="md:h-screen" />\n<main class={full ? "h-screen" : "min-h-screen"} />',
      "packages/ui/src/page.tsx": '<main class="min-h-screen" />',
      "packages/demo/src/valid.tsx": '<main class="h-dvh min-h-dvh max-h-[85vh] min-h-[50vh]" />',
      "packages/demo/src/page.browser.test.tsx": '<main class="h-screen min-h-screen" />',
      "packages/demo/src/page.spec.tsx": '<main class="h-screen" />',
      "packages/demo/src/helper.ts": 'const example = "h-screen";',
      "packages/demo/test/page.tsx": '<main class="h-screen" />',
    };
    for (const [path, source] of Object.entries(files)) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map(({ file, line }) => `${relative(root, file!)}:${line}`).sort()).toEqual([
      "packages/demo/src/page.tsx:1",
      "packages/demo/src/page.tsx:2",
      "packages/demo/src/page.tsx:2",
      "packages/ui/src/page.tsx:1",
    ]);
    expect(findings.every(({ message }) => message.includes("dvh"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
