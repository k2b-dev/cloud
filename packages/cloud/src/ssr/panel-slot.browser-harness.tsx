import { AppWorkspace } from "@k2b/ui";
import { Hono } from "hono";
import { defineApp } from "../_internal/define-app";
import { person } from "../_internal/define-app.test-fixture";
import { createMePanelConsentRoutes } from "../api/me-panel-consent";
import type { RuntimeAppMeta } from "../contracts/app";
import type { User } from "../contracts/shared";
import Layout from "./Layout";
import PanelLayout from "./PanelLayout";
import { readPanelContext } from "./panel-context";
import type { RuntimeContext } from "./runtime";

type ConsentAnswer = { allowed: boolean; revision: number };
export const consentAnswers = new Map<string, Map<string, ConsentAnswer>>();
export const fixtureConsent = {
  get: async (userId: string, provider: string) => consentAnswers.get(userId)?.get(provider) ?? null,
  list: async (userId: string, providers: string[]) =>
    Object.fromEntries(
      providers.flatMap((id) => {
        const answer = consentAnswers.get(userId)?.get(id);
        return answer === undefined ? [] : [[id, answer]];
      }),
    ),
  set: async (userId: string, provider: string, allowed: boolean, revision: number) => {
    const answers = consentAnswers.get(userId) ?? new Map<string, ConsentAnswer>();
    if ((answers.get(provider)?.revision ?? 0) !== revision) return null;
    const saved = { allowed, revision: revision + 1 };
    answers.set(provider, saved);
    consentAnswers.set(userId, answers);
    return saved;
  },
};

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
    const id = c.req
      .header("cookie")
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("fixture_person="))
      ?.slice("fixture_person=".length);
    c.set("user", { ...person, ...(id ? { id } : {}) });
    await next();
  })
  .route("/api/me", createMePanelConsentRoutes(fixtureConsent))
  .get(
    "/app/:provider/panel",
    ...probe.ssr<Environment>((c) => () => (
      <PanelLayout c={c} title="Fixture panel">
        <output id="panel-context-probe">{JSON.stringify(readPanelContext(c))}</output>
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
        <a href="/app/fixture/panel?guard=multiple&mode=manual&step=2" id="internal-panel">
          Another panel document
        </a>
      </PanelLayout>
    )),
  )
  .get(
    "/app/fixture/long",
    ...probe.ssr<Environment>((c) => () => (
      <Layout context={{ scope: { type: "fixture.place", id: "place1" } }} c={c} title="Long fixture">
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
      <Layout context={{ scope: { type: "fixture.place", id: "place1" } }} c={c} fullWidth fullPage title="Panel fixture">
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
              <button type="button" id="change-context">
                Change place
              </button>
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
  return [
    ".layout-shell-content",
    "#cloud-panel",
    ".k2b-app-workspace",
    ".k2b-app-workspace__main",
    ".k2b-app-workspace__detail",
    "[data-app-workspace-detail-toggle]",
  ].map((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}

/** The question, provider frame and app area stay in the same reserved rectangles through hydration. */
export function consentGeometry() {
  return ["[data-cloud-panel-consent]", "[data-cloud-panel-frame]", "[data-cloud-app-area]"].map((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}
