import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { castsDepth, rule } from "./shadow-tokens";

test("a layer with blur casts depth; rings, hairlines, and tokens do not", () => {
  expect(castsDepth("0 2px 8px rgb(0 0 0 / 0.08)")).toBe(true);
  expect(castsDepth("inset 0 -1.375rem 1.625rem -1.625rem rgb(15 23 19 / 0.14)")).toBe(true);
  expect(castsDepth("0 0 0 1px var(--k2b-border), 0 1px 3px rgb(0 0 0 / 0.12)")).toBe(true);
  expect(castsDepth("inset 0 0 0 2px var(--k2b-edge-color)")).toBe(false);
  expect(castsDepth("inset 0 -1px 0 var(--k2b-border)")).toBe(false);
  expect(castsDepth("0 0 0 3px color-mix(in srgb, var(--k2b-action) 25%, transparent)")).toBe(false);
  expect(castsDepth("var(--k2b-shadow-toolbar), 0 0 0 1px rgb(9 9 11 / 0.06)")).toBe(false);
  expect(castsDepth("var(--k2b-shadow-float, 0 8px 24px rgb(0 0 0 / 0.16))")).toBe(false);
  expect(castsDepth("none")).toBe(false);
});

test("reports raw shadows in CSS and class lists, and allows tokens, rings, and justified exceptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-shadow-tokens-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/ui"] } }),
      "packages/ui/src/styles/index.css": [
        ".k2b-ui { --k2b-shadow-raised: 0 1px 2px rgb(15 23 19 / 0.05); --k2b-hover-depth: inset 0 -8px 12px rgb(0 0 0 / 0.1); }",
      ].join("\n"),
      "packages/demo/src/app.css": [
        ".card { box-shadow: var(--k2b-island-shadow); }",
        ".chip { box-shadow: inset 0 0 0 2px var(--k2b-border); }",
        ".bar { box-shadow: 0 2px 8px rgb(0 0 0 / 0.08); }",
        "@media (min-width: 40rem) { .pop { box-shadow: 0 18px 48px rgb(9 9 11 / 0.18); } }",
        ".app { --app-card-shadow: 0 4px 12px rgb(0 0 0 / 0.1); }",
        ".lift { @apply shadow-md; }",
        "/* .old { box-shadow: 0 2px 8px black; } */",
        "/* shadow-tokens: allow a halo keeps the handle visible on any photo */",
        ".handle { box-shadow: 0 1px 2px rgb(0 0 0 / 0.4); }",
        ".ghost { filter: drop-shadow(0 2px 4px rgb(0 0 0 / 0.2)); }",
      ].join("\n"),
      "packages/demo/src/page.tsx": [
        'const a = <div class="rounded-md border shadow-[var(--k2b-shadow-float)]" />;',
        'const b = <div class="rounded-md border shadow-lg" />;',
        'const c = <div class="ring-1 shadow-[0_0_0_2px_var(--k2b-surface)]" />;',
        'const d = <div class="px-2 shadow-[0_1px_4px_rgb(0_0_0/0.12)]" />;',
        'const e = <filter id="shadow" />;',
        "// a denial can shadow other rows",
        'const f = <div style="box-shadow: 0 2px 6px rgb(0 0 0 / 0.1)" />;',
        'const g = <div class="flex shadow-none" />;',
      ].join("\n"),
      "packages/demo/src/page.test.tsx": '<div class="shadow-lg" />',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`).sort()).toEqual([
      "packages/demo/src/app.css:10",
      "packages/demo/src/app.css:3",
      "packages/demo/src/app.css:4",
      "packages/demo/src/app.css:5",
      "packages/demo/src/app.css:6",
      "packages/demo/src/page.tsx:2",
      "packages/demo/src/page.tsx:4",
      "packages/demo/src/page.tsx:7",
      "packages/ui/src/styles/index.css:1",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
