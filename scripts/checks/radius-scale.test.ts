import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { onScale, rule, utilityOnScale } from "./radius-scale";

test("accepts the five K4 values and radius tokens only", () => {
  for (const value of ["0", "4px", "0.25rem", "8px", ".5rem", "14px", "9999px", "999px", "50%", "var(--k2b-radius-control)"])
    expect({ value, ok: onScale(value) }).toEqual({ value, ok: true });
  for (const value of [
    "var(--k2b-radius-mark) var(--k2b-radius-mark) 0 0",
    "var(--ui-radius-frame, 14px)",
    "inherit",
    "8px !important",
    "clamp(var(--k2b-radius-mark), (100% - 23.5px) * 1000, var(--k2b-radius-control))",
  ])
    expect({ value, ok: onScale(value) }).toEqual({ value, ok: true });
  for (const value of [
    "6px",
    "0.75rem",
    "28%",
    "calc(var(--k2b-radius-control) + 3px)",
    "var(--k2b-gap)",
    "var(--k2b-radius-control, 6px)",
    "clamp(4px, 50%, 8px)",
    "clamp(4px, (100% - 23.5px) * 1000, 12px)",
  ])
    expect({ value, ok: onScale(value) }).toEqual({ value, ok: false });
  for (const size of [undefined, "none", "sm", "lg", "full", "[8px]", "[var(--k2b-radius-card)]"]) expect(utilityOnScale(size)).toBe(true);
  for (const size of ["md", "xl", "2xl", "[10px]"]) expect(utilityOnScale(size)).toBe(false);
});

test("fails new findings, keeps baseline ones, and asks to remove fixed ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-radius-scale-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo"] } }),
      "packages/demo/src/app.css": [
        ".a { border-radius: 8px; }",
        ".b { border-radius: 6px; }",
        "/* .c { border-radius: 3px; } */",
        ".d { --demo-radius: 12px; border-top-left-radius: var(--demo-radius); }",
        ".e { @apply rounded-xl; }",
      ].join("\n"),
      "packages/demo/src/page.tsx": [
        '<div class="rounded-lg md:rounded-t-xl" />',
        '<div class="rounded-full rounded-[10px]" />',
        '<div style={{ borderRadius: \'5px\', "border-top-left-radius": "6px" }} />',
        "// rounded-md in a comment",
      ].join("\n"),
      "packages/demo/src/page.test.tsx": '<div class="rounded-md" />',
      "scripts/checks/radius-scale.baseline": [
        "# header",
        "packages/demo/src/app.css | css | 6px",
        "packages/demo/src/page.tsx | class | rounded-[10px]",
        "packages/demo/src/gone.css | css | 3px",
      ].join("\n"),
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line ?? ""}`).sort()).toEqual([
      "packages/demo/src/app.css:4",
      "packages/demo/src/app.css:5",
      "packages/demo/src/page.tsx:1",
      "packages/demo/src/page.tsx:3",
      "packages/demo/src/page.tsx:3",
      "scripts/checks/radius-scale.baseline:",
    ]);
    await rule.run({ workspaceRoot: root, fix: true, flags: new Set() });
    const baseline = await readFile(join(root, "scripts/checks/radius-scale.baseline"), "utf8");
    expect(baseline).not.toContain("gone.css");
    expect(baseline).toContain("packages/demo/src/app.css | css | 6px");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
