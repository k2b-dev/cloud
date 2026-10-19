import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "spaces-head-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: SpaceViewTabs } = await import("./SpaceViewTabs.island");

export const renderHeadTabs = (view: "list" | "table" | "kanban" | "calendar", query = `view=${view}`) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(AppWorkspace, {
          get children() {
            return [
              createComponent(AppWorkspace.Head, {
                get views() {
                  return createComponent(SpaceViewTabs, { spaceId: "Space1", query, currentView: view });
                },
              }),
              createComponent(AppWorkspace.Content, {
                get children() {
                  return createComponent(AppWorkspace.Main, { children: "Tasks" });
                },
              }),
            ];
          },
        });
      },
    }),
  );

test.each(["list", "table", "kanban", "calendar"] as const)("server head selects the resolved %s view", (view) => {
  const html = renderHeadTabs(view);
  expect(html).toContain(`href="/app/spaces/Space1?view=${view}" aria-current="page"`);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).not.toContain("k2b-app-workspace__switcher");
});

test("a remembered server view selects its tab even without a view parameter", () => {
  expect(renderHeadTabs("table", "q=ship")).toContain('href="/app/spaces/Space1?q=ship&amp;view=table" aria-current="page"');
});
