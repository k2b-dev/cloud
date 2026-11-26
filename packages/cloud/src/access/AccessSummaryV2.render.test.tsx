import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { AccessEntry } from "../contracts/shared";

registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(join(tmpdir(), "access-summary-v2-")) });
const { AccessSummary } = await import("./v2");
const { LocaleProvider } = await import("@k2b/ui");

const entry = (id: number, principal: AccessEntry["principal"], permission: AccessEntry["permission"], extra: Partial<AccessEntry> = {}) =>
  ({
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    principal,
    permission,
    createdAt: "2026-11-03T00:00:00.000Z",
    ...extra,
  }) as AccessEntry;
const user = (id: number) => ({ type: "user" as const, userId: `10000000-0000-4000-8000-${String(id).padStart(12, "0")}` });
const entries: AccessEntry[] = [
  entry(1, user(1), "admin", { displayName: "Mia Hoffmann", avatarHash: "abc" }),
  entry(2, user(2), "write", { displayName: "Jonas Weber" }),
  // the stronger grant of the same person counts once
  entry(3, user(2), "read", { displayName: "Jonas Weber" }),
  entry(4, { type: "group", groupId: "30000000-0000-4000-8000-000000000004" }, "read", { displayName: "Logistik" }),
  ...Array.from({ length: 6 }, (_, index) => entry(10 + index, user(10 + index), "read", { displayName: `Person ${index}` })),
  entry(20, { type: "authenticated" }, "read"),
  entry(21, { type: "service_account", serviceAccountId: "40000000-0000-4000-8000-000000000021" }, "write", {
    displayName: "Code",
    serviceAccountKind: "code",
  }),
];
const render = (locale: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(AccessSummary, { entries });
      },
    }),
  );

test("the members stand as one stack of five faces and +n, with the line of who else has access", () => {
  const html = render("en");
  expect(html.match(/data-k2-part="Avatar.Stack"/g)).toHaveLength(1);
  expect(html.match(/data-k2-part="Avatar"/g)).toHaveLength(5);
  // nine members: Mia, Jonas once, Logistik and six more people
  expect(html).toContain("+4");
  expect(html).toContain("/api/accounts/users/10000000-0000-4000-8000-000000000001/avatar");
  expect(html).toContain("9 people, groups and agents");
  expect(html).toContain("All signed-in people: View");
  expect(html).toContain("1 service account");
});

test("German readers read German words", () => {
  expect(render("de")).toContain("Alle angemeldeten Personen: Ansehen");
});
