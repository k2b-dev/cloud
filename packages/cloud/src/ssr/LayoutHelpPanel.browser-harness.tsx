import { keyboardPlatform } from "@k2b/ui";
import { Hono } from "hono";
import { defineApp } from "../_internal/define-app";
import { person } from "../_internal/define-app.test-fixture";
import type { AppAppearance, CloudRuntime } from "../contracts/app";
import type { User } from "../contracts/shared";
import type { HelpDocumentManifest, HelpDocumentPayload } from "../shared/help";
import { appAppearanceStyle } from "./app-appearance";
import Layout from "./Layout";
import { LayoutHelpPage, type LayoutHelpPageProps, LayoutHelpPanel, type LayoutHelpPanelProps } from "./LayoutHelp";
import { helpArticlePartsServer } from "./layout-help-article.server";
import PanelLayout from "./PanelLayout";
import { readPanelContext } from "./panel-context";

export const documents: HelpDocumentManifest[] = [
  { id: "spaces-share", title: "Share a Space", kind: "task", icon: "ti ti-share" },
  { id: "spaces-start", title: "Start with Spaces", kind: "start", icon: "ti ti-rocket" },
].map((topic) => ({
  ...topic,
  kind: topic.id === "spaces-share" ? "task" : "start",
  order: 1,
  url: `/api/help/${topic.id}`,
  searchUrl: "/api/help/search",
}));
export const helpManifest = { documents, pageBase: "/help/apps/spaces", baseLocale: "en", locale: "en", manifestHash: "fixture" };
export const fixtureDocument: HelpDocumentPayload = {
  id: "spaces-share",
  title: "Share a Space",
  locale: "en",
  markdown: "Share",
  kind: "task",
  needs: "manage",
  related: [],
  // A lead, the facts chips, and a section: everything the article head reads from the article.
  html: '<p>Share a Space so other people can see and edit its tasks.</p><h2 id="share">Share</h2><div class="help-steps"><ol><li>Open Space settings.</li><li>Add a person.</li></ol></div>',
};
const { html, ...payload } = fixtureDocument;
const initialArticle = { payload, parts: helpArticlePartsServer(html) };
const appearance: AppAppearance = { accent: "#16a34a", background: { from: "#16a34a", to: "#0284c7" } };
const apps: CloudRuntime["apps"] = [
  {
    id: "spaces",
    name: "Spaces",
    icon: "ti ti-box",
    description: "Help fixture",
    routes: ["/app/spaces"],
    nav: { href: "/app/spaces", section: "primary" },
    appearance,
    help: helpManifest,
  },
  {
    id: "core",
    name: "Core",
    icon: "ti ti-cloud",
    description: "Core fixture",
    routes: ["/"],
    panel: { href: "/panel", label: "Help", icon: "ti ti-help-circle" },
  },
];
const app = defineApp({
  id: "help-fixture",
  name: "Help fixture",
  description: "Help fixture",
  icon: "ti ti-help-circle",
  baseUrl: "http://fixture:3000",
  routes: ["/"],
});
type Environment = { Variables: { runtime: CloudRuntime; user: User } };
const PropsSnapshot = (props: { value: LayoutHelpPanelProps | LayoutHelpPageProps }) => (
  <script id="help-fixture-props" type="application/json" innerHTML={JSON.stringify(props.value).replace(/</g, "\\u003c")} />
);
export const server = new Hono<Environment>()
  .use(async (c, next) => {
    c.set("runtime", { apps });
    c.set("user", person);
    await next();
  })
  .get(
    "/app/spaces",
    ...app.ssr<Environment>((c) => () => (
      <Layout c={c} title="Spaces" help={["spaces-share"]}>
        <p>App content</p>
      </Layout>
    )),
  )
  .get(
    "/panel",
    ...app.ssr<Environment>((c) => {
      const context = readPanelContext(c);
      const props: LayoutHelpPanelProps = {
        documents,
        app: { id: "spaces", name: "Spaces", icon: "ti ti-box" },
        appearance: appAppearanceStyle(appearance),
        view: context?.app === "spaces" ? context.help?.filter((id) => documents.some((topic) => topic.id === id)) : [],
        platform: keyboardPlatform(c.req.header("User-Agent") ?? ""),
        pageBase: helpManifest.pageBase,
        initialArticle: c.req.query("topic") === "spaces-share" ? initialArticle : undefined,
        initialTopic: c.req.query("topic") === "spaces-share" ? "spaces-share" : undefined,
      };
      return () => (
        <PanelLayout c={c} title="Help">
          <div id="help-fixture-root" class="flex h-full min-h-0 flex-1 flex-col">
            <LayoutHelpPanel {...props} />
          </div>
          <PropsSnapshot value={props} />
        </PanelLayout>
      );
    }),
  )
  .get(
    "/help/apps/spaces/spaces-share",
    ...app.ssr<Environment>((c) => () => (
      <Layout c={c} title="Help">
        <div id="help-fixture-root">
          <LayoutHelpPage
            documents={documents}
            initialTopic="spaces-share"
            initialArticle={initialArticle}
            pageBase={helpManifest.pageBase}
          />
        </div>
        <PropsSnapshot value={{ documents, initialTopic: "spaces-share", initialArticle, pageBase: helpManifest.pageBase }} />
      </Layout>
    )),
  );

/**
 * Capture during parsing and immediately after mounting; coordinates inside the provider are relative to its viewport.
 * The article head keeps its position, width and height; the contents column keeps its position and width.
 */
export function helpPanelGeometry() {
  return ["[data-help-view]", "[data-cloud-app-area]", ".help-article-head", ".help-article-aside"].map((selector, index) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    if (!rect) return null;
    return index < 3 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : { x: rect.x, y: rect.y, width: rect.width };
  });
}
