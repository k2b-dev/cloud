import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./layout-check-coverage";

test("a browser test that calls layoutProblems runs with classic scrollbars and covers 1100 px", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-layout-check-coverage-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo"] } }),
      // Covered: the shared helper and the shared widths.
      "packages/demo/src/good.browser.test.ts":
        'import { launchWithScrollbars } from "x";\nimport { layoutProblems, layoutWidths, scrollbarWidth } from "@k2b/ui/layout-check";\n',
      // Covered: the launch option and the number.
      "packages/demo/test/plain.browser.test.ts":
        'chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });\npage.evaluate(scrollbarWidth);\nfor (const width of [390, 1100]) page.evaluate(layoutProblems);\n',
      // Classic scrollbars, but nothing checks that they take room.
      "packages/demo/src/unprobed.browser.test.ts":
        "browser = await launchWithScrollbars();\nfor (const width of layoutWidths) page.evaluate(layoutProblems);\n",
      // Both gaps.
      "packages/demo/src/bare.browser.test.ts": "for (const width of [390, 1440]) page.evaluate(layoutProblems);\n",
      // A gap that is known.
      "packages/demo/src/known.browser.test.tsx":
        "browser = await launchWithScrollbars();\npage.evaluate(scrollbarWidth);\npage.evaluate(layoutProblems);\n",
      // Not a layout test.
      "packages/demo/src/other.browser.test.ts": "for (const width of [390]) page.click();\n",
      "scripts/checks/layout-check-coverage.baseline": "# header\npackages/demo/src/known.browser.test.tsx | 1100\n",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}: ${finding.message.split(":")[0]}`).sort()).toEqual([
      "packages/demo/src/bare.browser.test.ts: calls layoutProblems without 1100 px, where the detail column is open",
      "packages/demo/src/bare.browser.test.ts: calls layoutProblems without classic scrollbars that take room",
      "packages/demo/src/unprobed.browser.test.ts: calls layoutProblems without classic scrollbars that take room",
    ]);

    // A known gap that is closed must leave the baseline.
    await writeFile(
      join(root, "packages/demo/src/known.browser.test.tsx"),
      "launchWithScrollbars();\nscrollbarWidth;\nlayoutProblems;\nlayoutWidths;\n",
    );
    const stale = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(stale.some((finding) => finding.message.startsWith("Fixed: remove “packages/demo/src/known.browser.test.tsx | 1100”"))).toBe(
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
