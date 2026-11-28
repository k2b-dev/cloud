import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./no-moved-hints";

test("finds moved hints in applications, not in the libraries that own them or in tests", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-no-moved-hints-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/ui", "packages/cloud"] } }),
      "packages/demo/src/Head.tsx": [
        'import { MovedHint } from "@k2b/ui";',
        "<MovedHint open={open()} target={() => button} onDismiss={close}>Filters moved</MovedHint>",
        "<Panes items={items} arrangeHint={{ open: true, onDismiss }} />",
      ].join("\n"),
      "packages/demo/src/page.tsx": 'const open = hintOpen(c, "demo.filters", { allowed: true });\nmarkHintSeen(c, "demo.filters");',
      // A tooltip on an icon and a field hint are no moved hints.
      "packages/demo/src/Rail.tsx": '<RailItemHint label="Files" /><Field hint="Optional" />',
      "packages/demo/src/Head.test.tsx": "<MovedHint open target={() => button} />",
      "packages/ui/src/layout/Panes.tsx": "<MovedHint open={props.arrangeHint?.open} />",
      "packages/cloud/src/ssr/hints.ts": "export const hintOpen = () => markHintSeen(c, id);",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`).sort()).toEqual([
      "packages/demo/src/Head.tsx:2",
      "packages/demo/src/Head.tsx:3",
      "packages/demo/src/page.tsx:1",
      "packages/demo/src/page.tsx:2",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
