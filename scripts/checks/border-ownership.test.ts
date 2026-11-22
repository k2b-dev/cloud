import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./border-ownership";

test("reports outer borders on component roots outside framed elements; known ones stay in the baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-border-ownership-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/ui", "packages/demo"] } }),
      "packages/ui/src/styles/index.css": [
        ".k2b-ui .k2b-ledger { border-bottom: 1px solid var(--k2b-border); }",
        ".k2b-ui .k2b-ledger__row { border-top: 1px solid var(--k2b-border); }",
        ".k2b-ui .k2b-button { border: 1px solid var(--k2b-border-strong); }",
        ".k2b-ui .k2b-menu-list { border: 1px solid var(--k2b-border); }",
        ".k2b-ui :where(.k2b-divided) > :not([hidden]) ~ :not([hidden]) { border-block-start: 1px solid var(--k2b-border); }",
        ".k2b-ui .k2b-strip { border: 0; border-top: none; border-color: red; }",
        "/* .k2b-ui .k2b-old { border: 1px solid red; } */",
        ".k2b-ui .k2b-known { border: 1px solid var(--k2b-border); }",
        // A chat decision is a card (Gustav flat): framed by definition.
        ".k2b-ui .k2b-chat-decision { border: 1px solid var(--k2b-chat-card-edge); }",
      ].join("\n"),
      "packages/demo/src/Panel.tsx": [
        "export const Panel = () => (",
        '  <section class="border-b px-4">',
        '    <div class="border-t">A child is the container\'s business</div>',
        "  </section>",
        ");",
        'export const Card = () => <article class="demo-card rounded-lg border p-4">Framed</article>;',
        'export const Field = () => <input class="border px-2" />;',
        'export const Plain = () => <div class="border-0 border-zinc-200">No width</div>;',
      ].join("\n"),
      "packages/demo/src/Panel.test.tsx": 'const x = <div class="border-b" />;',
      "scripts/checks/border-ownership.baseline": "# header\npackages/ui/src/styles/index.css | css | .k2b-ui .k2b-known border\n",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`).sort()).toEqual([
      "packages/demo/src/Panel.tsx:2",
      "packages/ui/src/styles/index.css:1",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
