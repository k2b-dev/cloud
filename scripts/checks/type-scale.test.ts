import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { readingSize, rule, signsOnly, sizeOnScale, weightOnScale } from "./type-scale";

test("accepts the four type roles, keywords, and 1em only", () => {
  for (const value of [
    "var(--k2b-font-size-meta)",
    "var(--k2b-font-size-lead)",
    "inherit",
    "1em",
    "0",
    "var(--k2b-field-font-size, var(--k2b-font-size-row))",
  ])
    expect({ value, ok: sizeOnScale(value, { literals: false }) }).toEqual({ value, ok: true });
  for (const value of [
    "0.75rem",
    "11px",
    "0.8125em",
    "var(--k2b-type-12)",
    "var(--k2b-field-font-size, 0.8125rem)",
    "clamp(1rem, 2vw, 2rem)",
  ])
    expect({ value, ok: sizeOnScale(value, { literals: false }) }).toEqual({ value, ok: false });
  // Outside @k2b/ui a literal on the scale is no finding; one off the scale is.
  for (const value of ["12px", "0.8125rem", "14px", "1.125rem"]) expect(sizeOnScale(value, { literals: true })).toBe(true);
  for (const value of ["11px", "0.9375rem", "1rem", "20px"]) expect(sizeOnScale(value, { literals: true })).toBe(false);
  // Reading text adds 16 px headings and sizes relative to its text.
  for (const value of ["1rem", "0.88em", "16px", "var(--k2b-font-size-body)"]) expect(readingSize(value)).toBe(true);
  for (const value of ["15px", "1.5rem"]) expect(readingSize(value)).toBe(false);
  for (const value of ["400", "500", "600", "normal", "inherit", "var(--k2b-font-weight-lead)"]) expect(weightOnScale(value)).toBe(true);
  for (const value of ["650", "700", "bold", "300"]) expect(weightOnScale(value)).toBe(false);
});

test("treats icons, avatars, and checkbox marks as signs, not text", () => {
  for (const selector of [
    ".k2b-ui .k2b-toast__icon",
    ".k2b-ui .k2b-button > i",
    ".a i:first-child, .b .k2b-avatar",
    ".k2b-ui .k2b-dropdown__checkbox",
  ])
    expect({ selector, sign: signsOnly(selector) }).toEqual({ selector, sign: true });
  for (const selector of [".k2b-ui .k2b-tag", ".k2b-ui .k2b-button > i, .k2b-ui .k2b-button", ".k2b-ui .k2b-status-badge"])
    expect({ selector, sign: signsOnly(selector) }).toEqual({ selector, sign: false });
});

test("holds @k2b/ui strictly, keeps app findings in a baseline, and asks to remove fixed ones", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-type-scale-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/ui", "packages/demo"] } }),
      "packages/ui/src/styles/index.css": [
        ".k2b-ui { --k2b-font-size-meta: 0.75rem; --k2b-font-weight-lead: 600; }",
        ".k2b-ui .k2b-tag { font-size: 0.6875rem; }",
        ".k2b-ui .k2b-row { font-size: var(--k2b-font-size-row); font-weight: 650; }",
        ".k2b-ui .k2b-row > i { font-size: 1.25rem; }",
        "@media (pointer: coarse) { .k2b-ui .k2b-input { font-size: max(1rem, 16px); } }",
        ".k2b-ui .k2b-content-markdown h2 { font-size: 1rem; }",
        "/* type-scale: allow a drawing */",
        ".k2b-ui .k2b-signature { font-size: 2.5rem; }",
        ".k2b-ui .k2b-doc { @apply text-[10px] font-medium; }",
      ].join("\n"),
      "packages/demo/src/app.css": [".a { font-size: 12px; }", ".b { font-size: 11px; }", ".c { font: 700 15px/1.4 sans-serif; }"].join(
        "\n",
      ),
      "packages/demo/src/page.tsx": [
        '<div class="text-meta text-xs text-sm text-[13px] text-[var(--x)] text-red-500 font-semibold" />',
        '<div class="md:text-[11px] text-base font-bold" />',
        '<div style={{ fontSize: "10px" }} />',
        "// text-[9px] in a comment",
      ].join("\n"),
      "packages/demo/src/page.test.tsx": '<div class="text-[9px]" />',
      "scripts/checks/type-scale.baseline": [
        "# header",
        "packages/demo/src/app.css | size | 11px",
        "packages/demo/src/page.tsx | size | md:text-[11px]",
        "packages/demo/src/gone.css | size | 10px",
      ].join("\n"),
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line ?? ""}`).sort()).toEqual([
      "packages/demo/src/app.css:3",
      "packages/demo/src/app.css:3",
      "packages/demo/src/page.tsx:2",
      "packages/demo/src/page.tsx:2",
      "packages/demo/src/page.tsx:3",
      "packages/ui/src/styles/index.css:2",
      "packages/ui/src/styles/index.css:3",
      "packages/ui/src/styles/index.css:9",
      "scripts/checks/type-scale.baseline:",
    ]);
    await rule.run({ workspaceRoot: root, fix: true, flags: new Set() });
    const baseline = await readFile(join(root, "scripts/checks/type-scale.baseline"), "utf8");
    expect(baseline).not.toContain("gone.css");
    expect(baseline).toContain("packages/demo/src/app.css | size | 11px");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
