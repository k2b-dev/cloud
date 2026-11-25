import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

// Navigation, a section of Apps on v2, as the server renders it: the shortcuts, their audiences, and the open one.
const root = mkdtempSync(join(tmpdir(), "core-navigation-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { default: NavigationScreen }, { adminNavFixture }] = await Promise.all([
  import("@k2b/ui"),
  import("./NavigationScreen"),
  import("../admin-v2.fixture"),
]);
const nav = adminNavFixture("/admin/apps");
const render = (locale: string, props: Omit<Parameters<typeof NavigationScreen>[0], "nav">) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(NavigationScreen, { nav, ...props });
      },
    }),
  );

test("an empty bar offers the first shortcut, the cache and no loader", () => {
  const empty = render("de", { initial: { revision: 0, entries: [] }, apps: [], open: null });
  expect(empty).toContain("Noch keine globalen Shortcuts");
  expect(empty).toContain("Neuer Shortcut");
  expect(empty).toContain("fünf Minuten");
  expect(empty).toContain("Cache für alle Nutzer leeren");
  expect(empty).not.toMatch(/data-k2-part="Loading"|aria-busy="true"/);
});

test("a shortcut to a missing app says so; the open shortcut is a form with its order deeds", () => {
  const initial = { revision: 1, entries: [{ shortcut: { id: "missing", kind: "app" as const, appId: "missing" }, access: [] }] };
  const list = render("en", { initial, apps: [], open: null });
  expect(list).toContain("App currently unavailable");
  expect(list).toContain("No audience selected");
  const open = render("en", { initial, apps: [], open: "missing" });
  expect(open).toContain('aria-label="Move up"');
  expect(open).toContain('aria-label="Move down"');
  expect(open).toContain("Restrict audience");
});
