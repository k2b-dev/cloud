import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./glass-surfaces";

test("allows blur only on the overlay surface and dialog backdrops", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-glass-surfaces-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo"] } }),
      "packages/demo/src/app.css": [
        ".k2b-ui .k2b-overlay-surface { backdrop-filter: blur(22px) saturate(1.6); }",
        ".k2b-ui .k2b-dialog::backdrop { backdrop-filter: blur(8px); }",
        ".save-bar { backdrop-filter: none; }",
        "/* .comment { backdrop-filter: blur(2px); } */",
        ".save-bar { background: white; backdrop-filter: blur(12px); }",
        "@utility menu-surface { -webkit-backdrop-filter: blur(14px); }",
        "@media (min-width: 40rem) { .chip { @apply backdrop-blur-sm; } }",
      ].join("\n"),
      "packages/demo/src/page.tsx": [
        '<div class="k2b-overlay-surface backdrop-blur-none" />',
        '<div class="bg-white/90 backdrop-blur-sm" />',
        '<div class="dark:backdrop-blur" />',
        "<div style={{ backdropFilter: 'blur(4px)' }} />",
      ].join("\n"),
      "packages/demo/src/page.test.tsx": '<div class="backdrop-blur" />',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`).sort()).toEqual([
      "packages/demo/src/app.css:5",
      "packages/demo/src/app.css:6",
      "packages/demo/src/app.css:7",
      "packages/demo/src/page.tsx:2",
      "packages/demo/src/page.tsx:3",
      "packages/demo/src/page.tsx:4",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
