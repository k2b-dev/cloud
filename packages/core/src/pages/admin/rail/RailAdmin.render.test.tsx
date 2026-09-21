import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "core-rail-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const [{ LocaleProvider }, { default: RailAdmin }] = await Promise.all([import("@k2b/ui"), import("./RailAdmin.island.tsx")]);
test("admin page renders translated empty and unavailable states with accessible ordering controls", () => {
  const empty = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(RailAdmin, { initial: { revision: 0, entries: [] }, apps: [] });
      },
    }),
  );
  expect(empty).toContain("Noch keine globalen Shortcuts");
  expect(empty).toContain("Shortcut hinzufügen");
  expect(empty).toContain("fünf Minuten");
  expect(empty).toContain("Cache für alle Nutzer leeren");
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(RailAdmin, {
          initial: { revision: 1, entries: [{ shortcut: { id: "missing", kind: "app", appId: "missing" }, access: [] }] },
          apps: [],
        });
      },
    }),
  );
  expect(html).toContain("<table");
  expect(html).toContain("Destination");
  expect(html).toContain("Audience");
  expect(html).toContain("App currently unavailable");
  expect(html).toContain("No audience selected");
  expect(html).toContain('aria-label="Move up"');
  expect(html).toContain('aria-label="Move down"');
});
