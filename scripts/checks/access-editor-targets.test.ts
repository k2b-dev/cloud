import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkSource, rule } from "./access-editor-targets";

for (const source of [
  "openAccessDialog({ resourceName: name });",
  "<PermissionEditor canEdit={canManage()} />",
  "<PrincipalPicker onSelect={grant} />",
  "<ServiceAccountLookup add={grant} />",
  "<AccessDialog close={close} />",
  "openAccessDialog(options)",
  "openAccessDialog({...options})",
  "<AccessDialog {...options} />",
  "<PermissionEditor target={ref} {...options} />",
]) {
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
  expect(checkSource(resolve(import.meta.dir, "../../packages/cloud/src/access/AppAccessEditor.tsx"), "<PermissionEditor />")).toEqual([]);
  expect(checkSource("packages/another/cloud/src/access/AppAccessEditor.tsx", "<PermissionEditor />")).toHaveLength(1);
  expect(checkSource("packages/cloud/src/access/AnotherAppAccessEditor.tsx", "<PermissionEditor />")).toHaveLength(1);
  expect(checkSource("app.behavior.test.tsx", "<PermissionEditor />")).toEqual([]);
  expect(checkSource("PermissionEditor.browser-harness.tsx", "<PermissionEditor />")).toEqual([]);
});
test("every current resource editor carries its target", async () => {
  expect(await rule.run({ workspaceRoot: resolve(import.meta.dir, "../.."), fix: false, flags: new Set() })).toEqual([]);
});

test("resolves local spreads and rejects later overrides or opaque options", () => {
  expect(checkSource("app.tsx", `const options = {target: ref}; openAccessDialog({...options}); <AccessDialog {...options} />;`)).toEqual(
    [],
  );
  expect(
    checkSource(
      "app.tsx",
      `<PrincipalPicker target={ref} />; <PrincipalPicker readOnly />; <PrincipalPicker allowServiceAccounts={false} />;`,
    ),
  ).toEqual([]);
  expect(checkSource("app.tsx", `const options = {...unknown, target: ref}; openAccessDialog(options);`)).toEqual([]);
  expect(checkSource("app.tsx", `const options = {target: undefined}; openAccessDialog(options);`)).toHaveLength(1);
});

test("nested opaque spreads invalidate earlier targets while empty spreads preserve them", () => {
  expect(checkSource("app.tsx", `const options = {...unknown, label: name}; <AccessDialog target={ref} {...options} />;`)).toHaveLength(1);
  expect(checkSource("app.tsx", `const options = {...unknown, label: name}; openAccessDialog({target: ref, ...options});`)).toHaveLength(1);
  expect(checkSource("app.tsx", `<AccessDialog target={ref} {...{}} />; openAccessDialog({target: ref, ...{}});`)).toEqual([]);
});

test("identity-only service account kinds are parsed independent of spacing or order", () => {
  expect(
    checkSource(
      "app.tsx",
      `<PrincipalPicker serviceAccountKinds={['agent', 'standalone']} />; <PrincipalPicker serviceAccountKinds={["agent"]} />;`,
    ),
  ).toEqual([]);
  expect(
    checkSource("app.tsx", `<PrincipalPicker serviceAccountKinds={["agent", "code"]} />; <PrincipalPicker serviceAccountKinds={[]} />;`),
  ).toHaveLength(2);
});
