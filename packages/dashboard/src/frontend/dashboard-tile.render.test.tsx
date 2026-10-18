import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import type { DashboardCatalogWidget } from "../shared";
import type { DashboardTileState } from "./widget-board";

const root = mkdtempSync(join(tmpdir(), "dashboard-tile-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { DashboardWidgetFrame } = await import("./dashboard-tile");

const widget: DashboardCatalogWidget = {
  key: "notebooks/recent",
  appId: "notebooks",
  appName: "Notebooks",
  appIcon: "ti ti-notebook",
  appAccent: "#eab308",
  title: "Recent notes",
  description: "Recent notes",
  sizes: ["small"],
  defaultSize: "small",
  suggest: true,
};
const states: DashboardTileState[] = [
  { status: "ok", widget: { title: "Recent notes", blocks: [{ kind: "placeholder", title: "No notes yet", icon: "ti ti-notebook" }] } },
  { status: "loading" },
  { status: "error" },
  { status: "timeout" },
  { status: "forbidden" },
  { status: "empty" },
];
for (const state of states) {
  test(`${state.status} keeps the whole widget in its source app accent scope`, () => {
    // The surrounding dashboard has its own accent; each widget must establish its own scope inside it.
    const html = renderToString(() =>
      createComponent(Dynamic, {
        component: "div",
        class: "app-accent-scope",
        style: "--app-accent:#2563eb",
        get children() {
          return createComponent(DashboardWidgetFrame, { widget, state });
        },
      }),
    );
    const scope = html.match(/<div class="dashboard-widget-accent app-accent-scope"[^>]*>/)?.[0];
    expect(scope).toBeDefined();
    expect(scope).toContain('data-app-id="notebooks"');
    expect(scope).toContain("--app-accent:#eab308");
    expect(scope).not.toContain("--app-accent:#2563eb");
    const descendants: string[] = [];
    new HTMLRewriter()
      .on('.dashboard-widget-accent.app-accent-scope[data-app-id="notebooks"] .k2b-widget', {
        element(element) {
          descendants.push(element.getAttribute("data-size") ?? "");
        },
      })
      .on('.dashboard-widget-accent.app-accent-scope[data-app-id="notebooks"] .k2b-widget__icon.k2b-icon-tile', {
        element() {
          descendants.push("header icon");
        },
      })
      .transform(html);
    expect(descendants).toEqual(["fill", "header icon"]);
    expect(html).toContain("ti ti-notebook");
    if (state.status === "ok" || state.status === "forbidden") expect(html).toContain('class="k2b-placeholder__icon k2b-icon-tile"');
    if (state.status === "loading" || state.status === "error" || state.status === "timeout")
      expect(html).toContain('class="k2b-placeholder__icon"');
  });
}
