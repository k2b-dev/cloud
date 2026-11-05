import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkSource, rule } from "./access-editor-targets";

for (const source of ["openAccessDialog({ resourceName: name });", "<PermissionEditor canEdit={canManage()} />"]) {
  test(`a resource editor cannot silently omit its lookup target: ${source}`, () => {
    expect(checkSource("app.tsx", source)).toHaveLength(1);
  });
}
test("allows targeted editors, read-only views, and documented user-only audiences", () => {
  expect(
    checkSource(
      "app.tsx",
      `openAccessDialog({target: ref}); <PermissionEditor target={ref} />;
    <PermissionEditor canEdit={false} />; <PermissionEditor allowServiceAccounts={false} />;`,
    ),
  ).toEqual([]);
});
test("app management and test fixtures are not resource editors", () => {
  expect(checkSource("packages/cloud/src/access/AppAccessEditor.tsx", "<PermissionEditor />")).toEqual([]);
  expect(checkSource("app.behavior.test.tsx", "<PermissionEditor />")).toEqual([]);
  expect(checkSource("PermissionEditor.browser-harness.tsx", "<PermissionEditor />")).toEqual([]);
});
test("every current resource editor carries its target", async () => {
  expect(await rule.run({ workspaceRoot: resolve(import.meta.dir, "../.."), fix: false, flags: new Set() })).toEqual([]);
});
