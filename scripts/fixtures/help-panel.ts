import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LayoutHelpPanelProps } from "../../packages/cloud/src/ssr/layout-help-panel-types";
import { transform } from "../../packages/ssr/src/transform";

export const panelIslandEntries = [
  "HelpPanelBack",
  "HelpPanelMenu",
  "HelpPanelView",
  "HelpPanelShortcuts",
  "HelpPanelSearch",
  "HelpPanelArticle",
  "PanelRuntime",
].map((name) => resolve(import.meta.dir, `../../packages/cloud/src/ssr/${name}.island.tsx`));
export const panelFixtureDocuments = [
  { id: "share", title: "Share a Space", description: "Invite people.", kind: "task" as const, icon: "ti ti-share" },
  { id: "roles", title: "Roles", kind: "reference" as const },
  { id: "start", title: "First steps", kind: "start" as const },
].map((topic, order) => ({ ...topic, order, url: `/api/help/${topic.id}`, searchUrl: "/api/help/search", locale: "en" }));
export const panelFixtureProps: LayoutHelpPanelProps = {
  documents: panelFixtureDocuments,
  app: { id: "spaces", name: "Spaces", icon: "ti ti-box" },
  view: ["share"],
  pageBase: "/help/apps/spaces",
  platform: "other",
};

/** Real SSR transform, including the production island wrappers. No services, DB, or running stack. */
export async function createPanelRenderer() {
  const directory = mkdtempSync(join(tmpdir(), "help-panel-ssr-"));
  const root = resolve(import.meta.dir, "../..");
  const entry = resolve(root, "packages/cloud/src/ssr/help-panel-render-fixture.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { LocaleProvider } from "@k2b/ui";
import { LayoutHelpPanel as ServerPanel } from "${root}/packages/cloud/src/ssr/LayoutHelpPanel.server";
import { LayoutHelpPanel as LegacyPanel } from "${root}/packages/cloud/src/ssr/LayoutHelp";
export function run(props, legacy = false, locale = "en") {
  return renderToString(() => createComponent(LocaleProvider, { locale, get children() { return createComponent(legacy ? LegacyPanel : ServerPanel, props); } }));
}
`,
    },
    target: "bun",
    conditions: ["node"],
    plugins: [
      {
        name: "panel-server",
        setup(builder) {
          builder.onLoad({ filter: /\.(tsx|jsx)$/ }, async ({ path }) => ({
            contents: await transform(await Bun.file(path).text(), path, "ssr", true, root),
            loader: "js",
          }));
        },
      },
    ],
  });
  try {
    if (!build.success) throw new AggregateError(build.logs, "Could not compile server panel fixture");
    const output = join(directory, "server.mjs");
    await Bun.write(output, build.outputs[0]!);
    const module: { run: (props: LayoutHelpPanelProps, legacy?: boolean, locale?: string) => string } = await import(output);
    return { render: module.run, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
