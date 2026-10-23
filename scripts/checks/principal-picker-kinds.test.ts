import { expect, test } from "bun:test";
import { checkSource } from "./principal-picker-kinds";

for (const tag of ["PermissionEditor", "PrincipalPicker"]) {
  test(`${tag} accepts the inclusive default and an explicit inclusion`, () => {
    for (const prop of ["", "allowServiceAccounts", "allowServiceAccounts={true}"]) {
      expect(checkSource("packages/example/src/Access.tsx", `<${tag} ${prop} />`)).toEqual([]);
    }
  });
  test(`${tag} requires a reason for explicit and conditional exclusions`, () => {
    for (const prop of ["allowServiceAccounts={false}", "allowServiceAccounts={scope === 'base'}"]) {
      expect(checkSource("packages/example/src/Access.tsx", `<${tag} ${prop} />`)).toHaveLength(1);
    }
  });
}

test("documented user-backed workflows and test fixtures can exclude machine principals", () => {
  const source = "<PermissionEditor allowServiceAccounts={false} />";
  expect(checkSource("packages/assistant/src/artifacts/StudioPermissions.tsx", source)).toEqual([]);
  expect(checkSource("packages/example/src/Access.behavior.test.tsx", source)).toEqual([]);
});

test("renaming an imported picker does not bypass the guard", () => {
  expect(
    checkSource(
      "packages/example/src/Access.tsx",
      'import { PrincipalPicker as RecipientPicker } from "@k2b/cloud/access/ui"; <RecipientPicker allowServiceAccounts={false} />',
    ),
  ).toHaveLength(1);
});

test("Grids may conditionally exclude machine recipients until its custom-app API accepts them", () => {
  expect(
    checkSource(
      "packages/grids/src/frontend/_components/permissions/ScopedPermissionEditor.tsx",
      '<PermissionEditor allowServiceAccounts={props.scope.type !== "customApp"} />',
    ),
  ).toEqual([]);
});
