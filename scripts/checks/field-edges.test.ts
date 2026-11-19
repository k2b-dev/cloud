import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./field-edges";

test("reports thick field edges and width overrides, and allows the tokens, marks, and justified frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-field-edges-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/ui"] } }),
      "packages/ui/src/styles/index.css": ".k2b-ui { --k2b-edge-width: 1px; --k2b-frame-width: 2px; }",
      "packages/demo/src/app.css": [
        ".field { border: var(--k2b-edge-width) solid var(--k2b-edge-color); }",
        ".old { border: 2px solid var(--k2b-edge); }",
        ".chip { box-shadow: inset 0 0 0 2px var(--k2b-edge-focus), 0 0 0 3px transparent; }",
        ".ring { box-shadow: inset 0 0 0 var(--k2b-edge-width) var(--k2b-edge-focus), 0 0 0 var(--k2b-edge-ring-width) red; }",
        ".mark { border: 1.5px solid var(--k2b-edge-mark); }",
        ".frame { box-shadow: inset 0 0 0 var(--k2b-frame-width) var(--k2b-edge); }",
        ".scope { --k2b-edge-width: 2px; }",
        ".rem { outline: 0.125rem solid var(--k2b-edge-danger); }",
        "/* .gone { border: 2px solid var(--k2b-edge); } */",
        "/* field-edges: allow the map pin keeps its thick outline over photos */",
        ".pin { border: 2px solid var(--k2b-edge); }",
        ".graphic { border: 2px solid var(--k2b-border-strong); }",
      ].join("\n"),
      "packages/demo/src/page.tsx": [
        'const a = <div class="rounded-lg border-2 border-[var(--k2b-edge)]" />;',
        'const b = <div class="rounded-lg border border-[var(--k2b-edge)]" />;',
        'const c = <div class="border-2 border-white" />;',
        "{/* field-edges: allow a template editor keeps its writing frame */}",
        'const d = <div class="border-2 border-[var(--k2b-edge)]" />;',
      ].join("\n"),
      "packages/demo/src/page.test.tsx": '<div class="border-2 border-[var(--k2b-edge)]" />',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`).sort()).toEqual([
      "packages/demo/src/app.css:2",
      "packages/demo/src/app.css:3",
      "packages/demo/src/app.css:7",
      "packages/demo/src/app.css:8",
      "packages/demo/src/page.tsx:1",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
