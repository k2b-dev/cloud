import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkSource, rule } from "./inline-access-editors";

const editor = (props: string) =>
  `import { PermissionEditor } from "@k2b/cloud/access/ui";\nexport const Share = () => (\n  <PermissionEditor initialEntries={[]} ${props} />\n);\n`;

test("an app's editable inline PermissionEditor is a finding on its line", () => {
  for (const props of ["", "canEdit", "canEdit={true}", "canEdit={!saving()}"]) {
    const findings = checkSource("packages/notes/src/frontend/Share.tsx", editor(props));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "packages/notes/src/frontend/Share.tsx", line: 3 });
    expect(findings[0]!.message).toContain("openAccessDialog");
  }
});

test("a read-only list may stay inline", () => {
  expect(checkSource("packages/notes/src/frontend/Share.tsx", editor("canEdit={false}"))).toEqual([]);
});

test("the shared access package, tests, browser harnesses and the documented audience picker may render it", () => {
  for (const file of [
    "packages/cloud/src/access/AccessDialog.tsx",
    "packages/notes/src/frontend/Share.behavior.test.tsx",
    "packages/notes/src/frontend/Share.browser-harness.tsx",
    "packages/core/src/pages/admin/rail/RailAdmin.island.tsx",
  ])
    expect(checkSource(file, editor(""))).toEqual([]);
});

test("the summary and the dialog are not findings", () => {
  const source = `import { AccessSummary, openAccessDialog } from "@k2b/cloud/access/ui";\nexport const Share = () => <AccessSummary entries={[]} />;\n`;
  expect(checkSource("packages/notes/src/frontend/Share.tsx", source)).toEqual([]);
});

test("the repository has no other editable inline access editor", async () => {
  expect(await rule.run({ workspaceRoot: resolve(import.meta.dir, "../.."), fix: false, flags: new Set() })).toEqual([]);
});
