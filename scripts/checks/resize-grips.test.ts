import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./resize-grips";

test("a focusable separator and a column cursor belong to the shared grip", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-resize-grips-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo"] } }),
      "packages/demo/src/page.tsx": [
        'const a = <div role="separator" tabindex="0" class={`k2b-resize-separator ${extra}`} />;',
        'const b = <div role="separator" class="h-px" />;',
        'const c = <button type="button" role="separator" class="edge" />;',
        'const d = <div role="separator" tabIndex={0} />;',
        'const e = <div role="separator" tabindex="0" class="old-edge" />;',
        'const f = <div class="w-1 cursor-col-resize" />;',
      ].join("\n"),
      "packages/demo/src/app.css": [
        ".k2b-ui .k2b-resize-separator[data-orientation=vertical] { cursor: col-resize; }",
        ".edge { cursor: col-resize; }",
        ".event-handle { cursor: ns-resize; }",
        "/* .x { cursor: row-resize; } */",
      ].join("\n"),
      "scripts/checks/resize-grips.baseline": '# header\npackages/demo/src/page.tsx | separator | <div class="old-edge">\n',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`).sort()).toEqual([
      "packages/demo/src/app.css:2",
      "packages/demo/src/page.tsx:3",
      "packages/demo/src/page.tsx:4",
      "packages/demo/src/page.tsx:6",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
