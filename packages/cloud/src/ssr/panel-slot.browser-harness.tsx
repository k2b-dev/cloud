import { AppWorkspace } from "@k2b/ui";
import { Hono } from "hono";
import { defineApp } from "../_internal/define-app";
import { person } from "../_internal/define-app.test-fixture";
import type { RuntimeAppMeta } from "../contracts/app";
import type { User } from "../contracts/shared";
import Layout from "./Layout";
import PanelLayout from "./PanelLayout";
import type { RuntimeContext } from "./runtime";

const apps: RuntimeAppMeta[] = ["fixture", "second"].map((id) => ({
  id,
  name: id === "fixture" ? "Fixture" : "Second",
  icon: "ti ti-box",
  description: "Panel browser fixture",
  routes: [`/app/${id}`],
  nav: { href: `/app/${id}`, section: "primary" },
  panel: { href: `/app/${id}/panel`, label: id === "fixture" ? "Fixture" : "Second", icon: "ti ti-box" },
}));
const probe = defineApp({
  id: "fixture",
  name: "Fixture",
  icon: "ti ti-box",
  description: "Panel browser fixture",
  baseUrl: "http://fixture:3000",
  routes: ["/app/fixture", "/app/second"],
});
type Environment = { Variables: { runtime: RuntimeContext; user: User } };
export const server = new Hono<Environment>()
  .use(async (c, next) => {
    c.set("runtime", { apps });
    c.set("user", person);
    await next();
  })
  .get(
    "/app/:provider/panel",
    ...probe.ssr<Environment>((c) => () => (
      <PanelLayout c={c} title="Fixture panel">
        <label>
          Panel input
          <input aria-label="Panel input" />
        </label>
        <button type="button" id="prevent-escape">
          Keep Escape
        </button>
        <a href="/app/fixture/next" id="leave-panel">
          Open in the app
        </a>
      </PanelLayout>
    )),
  )
  .get(
    "/app/fixture/long",
    ...probe.ssr<Environment>((c) => () => (
      <Layout c={c} title="Long fixture">
        <button type="button" id="open-panel">
          Open fixture
        </button>
        <button type="button" id="open-silent-panel">
          Open silent fixture
        </button>
        <div style="height:150vh">Long content</div>
        <p id="last-row">Last row</p>
      </Layout>
    )),
  )
  .get(
    "/app/fixture/:page?",
    ...probe.ssr<Environment>((c) => () => (
      <Layout c={c} fullWidth fullPage title="Panel fixture">
        <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
          <AppWorkspace.Sidebar id="panel-navigation" label="Navigation">
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarItem href="/app/fixture" active>
                Workspace
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <button type="button" id="open-panel">
                Open fixture
              </button>
              <button type="button" id="open-silent-panel">
                Open silent fixture
              </button>
              <a href="/app/fixture/next" id="next-page">
                Next page
              </a>
              <textarea aria-label="App editor" />
            </AppWorkspace.Main>
            <AppWorkspace.Detail id="panel-fixture-detail" width="lg" open>
              <h2>Selected item</h2>
              <button type="button" data-workspace-detail-close>
                Close detail
              </button>
            </AppWorkspace.Detail>
          </AppWorkspace.Content>
        </AppWorkspace>
      </Layout>
    )),
  );

/** Runs inline during parsing and again immediately after mounting the real runtime. */
export function panelGeometry() {
  return [".layout-shell-content", "#cloud-panel", ".k2b-app-workspace"].map((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}
