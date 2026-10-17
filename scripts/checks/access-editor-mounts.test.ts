import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkSource, rule } from "./access-editor-mounts";

for (const tag of ["Show", "Match"]) {
  for (const editor of ["PermissionEditor", "ScopedPermissionEditor"]) {
    for (const gate of ["keyed", "keyed={true}", 'keyed="false"', "keyed={flag()}", "when={!query.refreshing() && !query.error()}"]) {
      test(`${tag} ${gate} must not remount ${editor}`, () => {
        const findings = checkSource("app.tsx", `<${tag} ${gate}><div>\n{() => <${editor} initialEntries={entries()} />}</div></${tag}>`);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ file: "app.tsx", line: 2 });
        expect(findings[0]!.message).toContain("stay mounted across refetches");
      });
    }
  }
}

test("allows stable Show and Match ancestors, literal keyed false, and unrelated siblings", () => {
  expect(
    checkSource(
      "app.tsx",
      `
    <Show when={data()} keyed={false}>
      {(entries) => <Match when={!query.error()}><PermissionEditor initialEntries={entries()}></PermissionEditor></Match>}
    </Show>;
    <Show keyed when={data()}><OtherEditor /></Show>;
    <Show when={!query.refreshing()}><OtherEditor /></Show>;
    <ScopedPermissionEditor initialEntries={data()} />;
  `,
    ),
  ).toEqual([]);
});

test("finds a distant unstable ancestor only once", () => {
  expect(checkSource("app.tsx", `<Show keyed><Match when={!query.refreshing()}><PermissionEditor /></Match></Show>`)).toHaveLength(1);
});

test("skips test files", () => {
  for (const name of ["app.test.tsx", "app.behavior.test.tsx", "app.spec.tsx"]) {
    expect(checkSource(name, "<Show keyed><PermissionEditor /></Show>")).toEqual([]);
  }
});

test("the current consumers keep access editors mounted", async () => {
  expect(await rule.run({ workspaceRoot: resolve(import.meta.dir, "../.."), fix: false, flags: new Set() })).toEqual([]);
});
