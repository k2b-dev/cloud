import { AppWorkspace } from "@k2b/ui";
import { Hono } from "hono";
import { defineApp } from "../_internal/define-app";
import { person } from "../_internal/define-app.test-fixture";
import type { User } from "../contracts/shared";
import Layout from "./Layout";
import type { RuntimeContext } from "./runtime";

const probe = defineApp({
  id: "shell-focus-probe",
  name: "Focus probe",
  icon: "ti ti-layout",
  description: "Shell focus browser fixture",
  baseUrl: "http://shell-focus-probe:3000",
  routes: ["/app/focus"],
});
type Environment = { Variables: { runtime: RuntimeContext; user: User } };
export const server = new Hono<Environment>()
  .use(async (c, next) => {
    c.set("runtime", {
      apps: [
        {
          id: "shell-focus-probe",
          name: "Focus probe",
          description: "Shell focus browser fixture",
          icon: "ti ti-layout",
          routes: ["/app/focus"],
          nav: { href: "/app/focus", section: "primary" },
        },
      ],
    });
    c.set("user", person);
    await next();
  })
  .get(
    "/app/focus",
    ...probe.ssr<Environment>((c) => () => (
      <Layout c={c} fullWidth fullPage title={[{ title: "Focus probe", href: "/app/focus" }, { title: "Workspace" }]}>
        <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
          <AppWorkspace.Sidebar id="focus-navigation" label="Navigation">
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarItem href="/app/focus" active>
                Workspace
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <textarea aria-label="Editor" />
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </Layout>
    )),
  );
