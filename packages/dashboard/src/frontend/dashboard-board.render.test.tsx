import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "dashboard-board-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ LocaleProvider }, { default: DashboardBoard }] = await Promise.all([import("@k2b/ui"), import("./dashboard-board")]);

const tile = (key: string, title: string) => ({ key, title, icon: "ti ti-box", href: `/app/${key.split("/")[0]}` });

test("the page renders every reserved widget as loading, in its own space, before any app has answered", () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(DashboardBoard, {
          focusRows: [[tile("spaces/today", "Spaces")]],
          overviewRows: [[tile("venue/today", "Venue"), tile("quotes/quote", "Quotes")]],
          context: [tile("weather/current", "Weather")],
          requestKeys: ["spaces/today", "venue/today", "quotes/quote", "weather/current", "accounts/admin-queue"],
          registeredKeys: ["spaces/today", "venue/today", "quotes/quote", "weather/current", "accounts/admin-queue"],
          hint: { forbidden: ["accounts/admin-queue"], empty: [] },
        });
      },
    }),
  );
  const slots = [...html.matchAll(/class="dashboard-widget-slot" data-widget="([^"]+)" data-state="([^"]+)"/g)].map((match) => [
    match[1],
    match[2],
  ]);
  expect(slots).toEqual([
    ["spaces/today", "loading"],
    ["venue/today", "loading"],
    ["quotes/quote", "loading"],
    ["weather/current", "loading"],
  ]);
  expect(html).toContain("Wird geladen …");
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain('role="alert"');
});

test("an empty board still asks the hidden-by-hint widgets but shows the empty state", () => {
  const html = renderToString(() =>
    createComponent(DashboardBoard, {
      focusRows: [],
      overviewRows: [],
      context: [],
      requestKeys: ["accounts/admin-queue"],
      registeredKeys: ["accounts/admin-queue"],
      hint: { forbidden: ["accounts/admin-queue"], empty: [] },
    }),
  );
  expect(html).not.toContain("dashboard-widget-slot");
  expect(html).toContain("No widgets to show.");
});
