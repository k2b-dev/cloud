import { basename, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { toJSON } from "seroval";
import { createPanelRenderer, panelFixtureProps, panelIslandEntries } from "../../../../scripts/fixtures/help-panel";
import { buildIslandClosure } from "../../../../scripts/fixtures/island-closure";
import { islandIdFromFile } from "../../../ssr/src/island-id";
import { helpArticlePartsServer } from "./layout-help-article.server";

/**
 * Build the real islands together, with the production mount runtime and shared ESM chunks. One module script imports
 * every island at once, as @k2b/ssr's loader does, so a held island does not hold the others.
 */
export async function helpPanelServerBrowserFixture() {
  const root = resolve(import.meta.dir, "../../../..");
  const renderer = await createPanelRenderer();
  const files: Record<string, string> = {};
  const entrypoints = panelIslandEntries.map((entry) => {
    const id = islandIdFromFile(entry, root);
    const virtual = resolve(import.meta.dir, `${id}.ts`);
    files[virtual] =
      `import { mount } from ${JSON.stringify(resolve(root, "packages/ssr/src/mount.ts"))}; import C from ${JSON.stringify(entry)}; mount(C, 'solid-island[data-id="${id}"]'); document.documentElement.dataset[${JSON.stringify(`mounted${id}`)}] = "true";`;
    return virtual;
  });
  try {
    const build = await buildIslandClosure(entrypoints, files);
    if (!build.metafile) throw new Error("Missing browser fixture metafile");
    const outputMeta = new Map(Object.entries(build.metafile.outputs).map(([path, output]) => [basename(path), output]));
    const eager = new Set<string>();
    const visit = (name: string) => {
      if (eager.has(name)) return;
      eager.add(name);
      for (const edge of outputMeta.get(name)?.imports ?? []) if (edge.kind !== "dynamic-import") visit(basename(edge.path));
    };
    const scripts = entrypoints.map((entry) => {
      const output = [...outputMeta].find(([, meta]) => meta.entryPoint && resolve(meta.entryPoint) === entry);
      if (!output) throw new Error(`Missing browser island entry ${entry}`);
      visit(output[0]);
      return output[0];
    });
    const outputs = new Map(await Promise.all(build.outputs.map(async (output) => [basename(output.path), await output.text()] as const)));
    const dynamicChunks = [...outputMeta.keys()].filter((name) => !eager.has(name));
    const chunkFor = (suffix: string) => {
      const found = [...outputMeta]
        .filter(([, meta]) => Object.entries(meta.inputs).some(([input, details]) => input.endsWith(suffix) && details.bytesInOutput > 0))
        .map(([name]) => name);
      if (!found.length) throw new Error(`Missing chunk for ${suffix}`);
      return found;
    };
    const styles = await Bun.build({ entrypoints: [resolve(root, "styles.css")], plugins: [tailwind] });
    if (!styles.success) throw new AggregateError(styles.logs, "Could not compile panel styles");
    const css = await styles.outputs[0]!.text();
    const initialArticle = {
      payload: {
        id: "share",
        title: "Share a Space",
        locale: "en",
        kind: "task" as const,
        needs: "edit" as const,
        markdown: "Share a Space.\n\n## Invite\n\nInvite people.",
        related: [],
      },
      parts: helpArticlePartsServer(
        '<p>Share a Space.</p><h2 id="invite">Invite</h2><p>Invite people.</p><a href="/help/apps/spaces/roles">Roles</a>',
      ),
    };
    const runtimeId = islandIdFromFile(panelIslandEntries.at(-1)!, root);
    const runtimeProps = JSON.stringify(toJSON({ provider: "fixture", scope: "/panel" }))
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");
    const app = new Hono()
      // Split chunks import each other by relative paths from the build's output layout; serve every file by name.
      .get("/:path{.+\\.js}", (c) => {
        const content = outputs.get(basename(c.req.path));
        return content === undefined ? c.notFound() : c.body(content, 200, { "content-type": "text/javascript" });
      })
      .get("/", (c) =>
        c.html(
          `<!doctype html><html lang="en"${themeClass(c.req.query("theme"))}><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div class="cloud-app-canvas" data-panel="open" data-panel-sheet="open" style="position:relative;display:flex;height:100dvh"><main data-cloud-app-area style="flex:1">Host app</main><aside class="cloud-panel" data-state="ready"><div class="cloud-panel__card"><header class="cloud-panel__head">Help</header><div class="cloud-panel__body"><iframe class="cloud-panel__frame" title="Help" src="/panel?${new URLSearchParams({ ...(c.req.query("topic") ? { topic: "share" } : {}), theme: c.req.query("theme") ?? "light" })}"></iframe></div></div></aside></div></body></html>`,
        ),
      )
      .get("/panel", (c) =>
        c.html(
          `<!doctype html><html lang="en"${themeClass(c.req.query("theme"))}><head><style>${css}</style><style>html,body{margin:0;height:100%}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body class="k2b-ui"><div class="cloud-panel-page" data-cloud-panel-page><script id="cloud-panel-context" type="application/json">{"v":1,"seq":0,"pageId":"22222222-2222-4222-8222-222222222222","app":"spaces","help":["share"]}</script><solid-island data-id="${runtimeId}" data-props="${runtimeProps}"></solid-island>${renderer.render({ ...panelFixtureProps, ...(c.req.query("topic") ? { initialTopic: "share", initialArticle } : {}) })}</div><script>document.documentElement.dataset.serverGeometry=JSON.stringify((${panelGeometry.toString()})());</script><script type="module">${JSON.stringify(scripts)}.forEach((file)=>import("/assets/"+file))</script></body></html>`,
        ),
      )
      .get("/api/help/search", (c) => c.json({ ids: ["share"] }))
      .get("/api/help/:id", (c) =>
        c.json({
          ...initialArticle.payload,
          id: c.req.param("id"),
          html: '<p>Fixture.</p><h2 id="invite">Invite</h2><p>Invite people.</p>',
        }),
      );
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    return {
      origin: `http://localhost:${server.port}`,
      dynamicChunks,
      searchChunks: chunkFor("/layout-help-panel-search.tsx"),
      menuChunks: chunkFor("/layout-help-panel-menu.tsx"),
      islandChunks: new Map(panelIslandEntries.map((entry, index) => [basename(entry), scripts[index]!])),
      ids: panelIslandEntries.map((entry) => islandIdFromFile(entry, root)),
      cleanup: () => {
        server.stop(true);
        renderer.cleanup();
      },
    };
  } catch (error) {
    renderer.cleanup();
    throw error;
  }
}

/** Cloud's theme script sets `dark` on the root; the fixture renders that class on the server for both documents. */
const themeClass = (theme: string | undefined) => (theme === "dark" ? ' class="dark"' : "");

/** First-frame geometry is the assertion subject, so callers also take it while action chunks are held. */
export function panelGeometry() {
  return [
    "[data-help-head]",
    "[data-help-search]",
    "[data-help-results]",
    "[data-help-tiles] button",
    "[data-help-server-article] [data-help-article-head]",
  ].map((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element || element.closest("[hidden]")) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
}
