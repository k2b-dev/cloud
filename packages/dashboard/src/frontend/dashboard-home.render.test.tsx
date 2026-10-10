import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { DashboardCatalogWidget } from "../shared";

const root = mkdtempSync(join(tmpdir(), "dashboard-home-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ LocaleProvider }, { default: DashboardHome }] = await Promise.all([import("@k2b/ui"), import("./dashboard-home")]);

const widget = (key: string, title: string, sizes: DashboardCatalogWidget["sizes"]): DashboardCatalogWidget => ({
  key,
  appId: key.split("/")[0]!,
  appName: key.split("/")[0]!,
  appIcon: "ti ti-box",
  appHref: `/app/${key.split("/")[0]}`,
  title,
  description: `${title} widget`,
  sizes,
  defaultSize: sizes.at(-1)!,
  suggest: true,
});
const props = (board: { key: string; size: "small" | "medium" | "large" }[]) => ({
  greeting: "Hallo, Mara",
  today: "Samstag, 10. Oktober",
  apps: [],
  legalLinks: [],
  shortcuts: [],
  catalog: [
    widget("spaces/today", "Heute", ["medium", "large"]),
    widget("weather/current", "Wetter", ["small", "medium"]),
    widget("quotes/quote", "Zitat", ["small"]),
  ],
  board,
  kept: [],
  followsDefault: true,
});
const render = (input: ReturnType<typeof props>) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(DashboardHome, input);
      },
    }),
  );

test("the page renders every widget of the board at its final size and loading, before any app answered", () => {
  const html = render(
    props([
      { key: "spaces/today", size: "large" },
      { key: "weather/current", size: "small" },
      { key: "quotes/quote", size: "small" },
    ]),
  );
  const tiles = [...html.matchAll(/<div[^>]*class="dashboard-tile"[^>]*>/g)].map((match) => [
    match[0].match(/data-key="([^"]+)"/)?.[1],
    match[0].match(/data-size="([^"]+)"/)?.[1],
    match[0].match(/data-state="([^"]+)"/)?.[1],
  ]);
  expect(tiles).toEqual([
    ["spaces/today", "large", "loading"],
    ["weather/current", "small", "loading"],
    ["quotes/quote", "small", "loading"],
  ]);
  // Each frame fills the cell its size reserves, with its declared title until the app answers.
  expect(html.match(/data-size="fill"/g)).toHaveLength(3);
  expect(html).toContain("Heute");
  expect(html).toContain("Wird geladen …");
  // The slow notice and the edit hint already have their lines, so neither moves anything when it appears.
  expect(html).toContain("spaces braucht länger als sonst.");
  expect(html).toMatch(/class="dashboard-edit-hint" aria-hidden="true"/);
  expect(html).toContain("Samstag, 10. Oktober");
  // The edit controls exist only in the edit mode.
  expect(html).not.toContain("dashboard-tile__remove");
  expect(html).not.toContain("dashboard-add-tile");
  expect(html).toContain("Bearbeiten");
});

test("an empty board offers to add a widget instead of a blank page", () => {
  const html = render(props([]));
  expect(html).not.toContain('class="dashboard-tile"');
  expect(html).toContain("Dein Dashboard ist leer.");
  expect(html).toContain("Widget hinzufügen");
});
