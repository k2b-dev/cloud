import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HelpDocumentManifest } from "../shared/help";
import type { LayoutHelpPageProps, LayoutHelpPanelProps } from "./LayoutHelp";
import { helpArticlePartsServer } from "./layout-help-article.server";
import type { ShellData } from "./shell-data";

type Frame = { panel?: Partial<LayoutHelpPanelProps>; page?: Partial<LayoutHelpPageProps>; shell?: ShellData; locale?: string };

/**
 * Help renders inside islands, so this compiles it as an island does: Solid's hydratable server output from the same
 * source tree on every side, as `LayoutHelp.hydration.test.ts` does for the browser.
 */
const fixture = await (async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", import.meta.dir))).default;
  const directory = mkdtempSync(join(tmpdir(), "cloud-layout-help-ssr-"));
  const entry = resolve(import.meta.dir, "LayoutHelp.ssr-fixture.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { LocaleProvider } from "@k2b/ui";
import { LayoutHelpPage, LayoutHelpPanel } from "./LayoutHelp";
import { ShellDataProvider } from "./shell-data";
export const run = ({ panel, page, shell, locale }) => renderToString(() => createComponent(LocaleProvider, { locale: locale ?? "en", get children() {
  const help = () => (panel ? createComponent(LayoutHelpPanel, panel) : createComponent(LayoutHelpPage, page));
  return shell ? createComponent(ShellDataProvider, { data: shell, get children() { return help(); } }) : help();
} }));`,
    },
    target: "bun",
    conditions: ["node"],
    plugins: [
      {
        name: "layout-help-ssr",
        setup(builder) {
          builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(import.meta.dir, "../../../ui/src/index.ts") }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "ssr", hydratable: true }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  try {
    if (!build.success) throw new AggregateError(build.logs, "Could not compile the Help server fixture");
    const path = join(directory, "server.mjs");
    await Bun.write(path, build.outputs[0]!);
    const module: { run?: unknown } = await import(path);
    const run = module.run;
    if (typeof run !== "function") throw new Error("The Help server fixture exports no run()");
    return { directory, run: (frame: Frame): string => String(run(frame)) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
})();
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));

/**
 * The server's first frame of every Help surface and state, frozen. Markup, classes, attributes, text, and Solid's
 * hydration markers must stay byte for byte. Solid derives two things from the component tree, so they change with every
 * component boundary without changing what a person sees: the hydration keys (`data-hk`) are left out, and the ids that
 * `createUniqueId()` builds from them (`k2b-dropdown-…`, `k2b-tooltip-…`, `k2b-field-…`) are replaced by their order of
 * appearance, so references between them still have to match. Server and browser compile the same tree, so they agree
 * on both; `LayoutHelp.hydration.test.ts` hydrates a server frame to prove it.
 * Regenerate with `bun test -u` only for an intended markup change.
 */
const canonical = (html: string) => {
  const ids = new Map<string, string>();
  return html.replace(/ data-hk="[0-9a-z]*"/g, "").replace(/\b(k2b-[a-z]+(?:-[a-z]+)*)-(\d[0-9a-z]*)\b/g, (id, prefix: string) => {
    let name = ids.get(id);
    if (!name) {
      name = `${prefix}-#${ids.size + 1}`;
      ids.set(id, name);
    }
    return name;
  });
};

const topic = (id: string, extra: Partial<HelpDocumentManifest> = {}): HelpDocumentManifest => ({
  id,
  title: `Article ${id}`,
  order: 10,
  url: `/api/help/apps/spaces/${id}`,
  searchUrl: "/api/help/apps/spaces/search",
  ...extra,
});
const documents: HelpDocumentManifest[] = [
  topic("share", { title: "Share a Space", icon: "ti ti-share", description: "Invite people to work with you.", order: 1 }),
  ...Array.from({ length: 9 }, (_, index) => topic(`task-${index + 1}`, { order: 20 + index })),
  topic("first-steps", { kind: "start", title: "First steps", description: "Find your way around." }),
  topic("roles", { kind: "reference", title: "Roles", icon: "ti-users" }),
  topic("sync", { kind: "troubleshoot", title: "Sync problems", description: "When changes do not arrive." }),
];
const { html: articleHtml, ...payload } = {
  id: "share",
  title: "Share a Space",
  locale: "en",
  kind: "task" as const,
  needs: "edit" as const,
  markdown: "Share",
  next: {
    appId: "spaces",
    appName: "Spaces",
    documentId: "roles",
    title: "Roles",
    description: "Who may do what.",
    url: "/help/apps/spaces/roles",
    accent: "#16a34a",
  },
  related: [
    { appId: "spaces", appName: "Spaces", documentId: "sync", title: "Sync problems", url: "/help/apps/spaces/sync" },
    {
      appId: "contacts",
      appName: "Contacts",
      documentId: "groups",
      title: "Contact groups",
      icon: "ti ti-users-group",
      url: "/help/apps/contacts/groups",
      accent: "#0284c7",
    },
  ],
  html: '<p>Share the Space with your team.</p><h2 id="invite">Invite people</h2><div class="help-steps"><ol><li>Open sharing.</li><li>Invite a person.</li></ol></div><h2 id="remove">Remove people</h2><p>Open <a href="/help/apps/spaces/roles">Roles</a>.</p>',
};
const initialArticle = { payload, parts: helpArticlePartsServer(articleHtml) };
const app = { id: "spaces", name: "Spaces", icon: "ti ti-layout-kanban" };
const shellData: ShellData = {
  apps: [
    { id: "spaces", label: "Spaces", href: "/app/spaces", match: "/app/spaces", iconClass: "ti ti-layout-kanban", defaultVisible: true },
  ],
  legalLinks: [],
  theme: "system",
  searchLinks: {},
  appId: "spaces",
  platform: "apple",
};

const panel = (props: Partial<LayoutHelpPanelProps> = {}, locale?: string) =>
  canonical(
    fixture.run({
      panel: { documents, app, appearance: "--app-accent:#16a34a", pageBase: "/help/apps/spaces", platform: "apple", ...props },
      locale,
    }),
  );
const page = (props: Partial<LayoutHelpPageProps> = {}, shell?: ShellData) =>
  canonical(fixture.run({ page: { documents, accent: "#16a34a", pageBase: "/app/spaces/help", ...props }, shell }));

describe("Help server frames", () => {
  test("panel start without and with For this view", () => {
    expect(panel()).toMatchSnapshot();
    expect(panel({ view: ["roles", "share", "unknown"] })).toMatchSnapshot();
    expect(panel({ view: ["share"] }, "de")).toMatchSnapshot();
  });

  test("panel article from ?topic=", () => {
    expect(panel({ initialTopic: "share", initialArticle })).toMatchSnapshot();
  });

  test("panel unavailable and failed", () => {
    expect(panel({ documents: [], app: undefined, state: "unavailable" })).toMatchSnapshot();
    expect(panel({ documents: [], state: "failed" })).toMatchSnapshot();
    expect(panel({ documents: [] })).toMatchSnapshot();
  });

  test("page hub and article", () => {
    expect(page()).toMatchSnapshot();
    expect(page({ initialTopic: "share", initialArticle })).toMatchSnapshot();
    // An article the server could not seed starts loading.
    expect(page({ initialTopic: "share" })).toMatchSnapshot();
  });

  test("embedded reader", () => {
    expect(page({ embedded: true, includeShortcuts: false })).toMatchSnapshot();
    expect(page({ embedded: true, initialTopic: "share", initialArticle })).toMatchSnapshot();
  });

  test("shortcuts on a Layout page and a failed Help read", () => {
    expect(page({}, shellData)).toMatchSnapshot();
    expect(page({ documents: [] }, { ...shellData, helpFailed: true })).toMatchSnapshot();
  });
});

// Additive server-provider frames; the original fourteen frames above remain the compatibility guard.
const serverPanelFixture = await (await import("../../../../scripts/fixtures/help-panel")).createPanelRenderer();
afterAll(serverPanelFixture.cleanup);
const serverPanel = (props: Partial<LayoutHelpPanelProps> = {}) =>
  canonical(
    serverPanelFixture.render({
      documents,
      app,
      appearance: "--app-accent:#16a34a",
      pageBase: "/help/apps/spaces",
      platform: "apple",
      ...props,
    }),
  );

for (const [name, props] of [
  ["start", {}],
  ["view", { view: ["roles", "share", "unknown"] }],
  ["article", { initialTopic: "share", initialArticle }],
  ["unavailable", { documents: [], app: undefined, state: "unavailable" }],
  ["failed", { documents: [], state: "failed" }],
  ["empty", { documents: [] }],
] satisfies [string, Partial<LayoutHelpPanelProps>][])
  test(`server provider ${name} frame`, () => expect(serverPanel(props)).toMatchSnapshot());

/** Compare visible markup, stripping only island bookkeeping, inert/hidden regions, menu references, and tree-derived ids. */
const visiblePanelMarkup = async (html: string) => {
  const { createDomTestHarness } = await import("../../../ui/test/dom");
  const dom = createDomTestHarness();
  try {
    dom.root.innerHTML = html;
    for (const node of dom.root.querySelectorAll("[hidden], script, [role=menu]")) node.remove();
    for (const wrapper of dom.root.querySelectorAll("solid-island, [data-help-start-content]")) wrapper.replaceWith(...wrapper.childNodes);
    for (const element of dom.root.querySelectorAll("*")) {
      for (const attribute of [...element.attributes]) {
        if (
          // The light menu triggers name no aria-controls: the legacy menu they would point to is removed above.
          ["aria-controls", "data-help-server-article", "data-help-initial-topic", "data-help-sections", "data-help-announcement"].includes(
            attribute.name,
          )
        )
          element.removeAttribute(attribute.name);
      }
      const attributes = [...element.attributes]
        .map((attribute) => [attribute.name, attribute.value] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
      for (const [name, value] of attributes) element.setAttribute(name, value);
    }
    return canonical(dom.root.innerHTML)
      .replace(/<!--[^]*?-->/g, "")
      .replace(/\s+(?:style=""|data-help-results="")/g, (value) => (value.trim().startsWith("style") ? "" : value));
  } finally {
    dom.cleanup();
  }
};
for (const [name, props] of [
  ["start", {}],
  ["view", { view: ["roles", "share"] }],
  ["article", { initialTopic: "share", initialArticle }],
] satisfies [string, Partial<LayoutHelpPanelProps>][]) {
  test(`server provider ${name} matches the legacy panel markup mechanically`, async () => {
    const data: LayoutHelpPanelProps = {
      documents,
      app,
      appearance: "--app-accent:#16a34a",
      pageBase: "/help/apps/spaces",
      platform: "apple",
      ...props,
    };
    expect(await visiblePanelMarkup(serverPanelFixture.render(data))).toBe(await visiblePanelMarkup(serverPanelFixture.render(data, true)));
  });
}

test("light menu trigger equals Dropdown.Trigger's button and tooltip markup", async () => {
  const { createDomTestHarness } = await import("../../../ui/test/dom");
  const dom = createDomTestHarness();
  const button = (light: boolean) => {
    dom.root.innerHTML = serverPanelFixture.render({ documents, app, platform: "apple" }, !light);
    const element = dom.root.querySelector("[data-help-menu]");
    if (!element) throw new Error("Missing menu trigger");
    // Generated ids and attribute order follow the component tree; the semantics and every class must agree.
    const attributes = [...element.attributes]
      .filter((attribute) => attribute.name !== "aria-controls")
      .map((attribute) => [attribute.name, attribute.value])
      .sort();
    return { attributes, markup: element.innerHTML };
  };
  try {
    expect(button(true)).toEqual(button(false));
  } finally {
    dom.cleanup();
  }
});
