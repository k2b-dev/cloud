import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { NoteGraph } from "../../../../service/links";
import type { BookTreeNode } from "../book/BookNavigator.island";
import { bigGraph, crossAreaGraph, FIXTURE_NOW, HANDBOOK_IDS, handbookGraph, unlinkedGraph } from "./graph.fixtures";
import { NotebookGraphFixture, type NotebookGraphFixtureProps } from "./notebook-graph.browser-harness";
import { parseGraphViewState } from "./view-state";

/** Notebook ids of the fixtures: the 49-note handbook, 300 notes, notes without links, and no notes. */
export const GRAPH_NOTEBOOKS: Record<string, { name: string; graph: () => NoteGraph; current: string | null }> = {
  hand01: { name: "Handbuch Logistik", graph: handbookGraph, current: HANDBOOK_IDS.wein! },
  big001: { name: "Wissensbasis Standort Nord", graph: bigGraph, current: null },
  free01: { name: "Projekt Hallenumbau", graph: unlinkedGraph, current: null },
  none01: { name: "Leer", graph: () => ({ nodes: [], edges: [] }), current: null },
  pair01: { name: "Zwei Bereiche", graph: crossAreaGraph, current: "regal0" },
};

const tree = (graph: NoteGraph): BookTreeNode[] => {
  const children = new Map<string | null, NoteGraph["nodes"]>();
  for (const node of graph.nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const build = (parent: string | null): BookTreeNode[] =>
    (children.get(parent) ?? [])
      .toSorted((a, b) => a.position - b.position)
      .map((node) => ({ id: node.id, title: node.title, children: build(node.id) }));
  return build(null);
};

/**
 * Serves the graph the way the page does: the server parses the view state from the URL and renders the island, the
 * browser clears and mounts it. `?theme=dark` renders dark and `?lang=de` German. Note pages are plain pages, so navigation
 * and Back are real.
 */
export async function startGraphServer() {
  const ui = `${resolve(import.meta.dir, "../../../../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "notebook-graph.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-notebook-graph-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the graph harness.");
  const bundle = await build.outputs[0]!.text();
  const stylesheets = [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (entry) => {
      const output = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!output.success) throw new AggregateError(output.logs, `Could not compile ${entry}.`);
      return output.outputs[0]!.text();
    }),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  const uiDist = resolve(ui, "dist");
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/harness.js")
        return new Response(bundle, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (url.pathname.startsWith("/ui/")) {
        const file = Bun.file(resolve(uiDist, url.pathname.slice(4)));
        return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
      }
      // The live Book update fails, so its notice shows.
      if (url.pathname.startsWith("/api/")) return new Response("Unavailable", { status: 503 });
      const dark = url.searchParams.get("theme") === "dark";
      const lang = url.searchParams.get("lang") === "de" ? "de" : "en";
      const page = (body: string, script = "") =>
        new Response(
          `<!doctype html><html lang="${lang}"${dark ? ' class="dark"' : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui/plex.css"><link rel="stylesheet" href="/ui/tabler.css"><style>${css}</style></head><body class="k2b-ui" style="margin:0;--app-accent:#eab308"><div id="root" style="height:100dvh;display:flex;flex-direction:column">${body}</div>${script}</body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      const note = /^\/app\/notebooks\/(\w{6})\/notes\/(\w{6})$/.exec(url.pathname);
      if (note && url.searchParams.get("mode") !== "graph") return page(`<main><h1 id="note-page">${note[2]}</h1></main>`);
      const notebookId = note?.[1] ?? /^\/app\/notebooks\/(\w{6})$/.exec(url.pathname)?.[1];
      const notebook = notebookId ? GRAPH_NOTEBOOKS[notebookId] : undefined;
      if (!notebookId || !notebook || url.searchParams.get("mode") !== "graph") return new Response("Not found", { status: 404 });
      const graph = notebook.graph();
      // As on the page, a note in the path wins over the `note` parameter.
      const selected = note?.[2] ?? url.searchParams.get("note") ?? notebook.current ?? graph.nodes[0]?.id ?? null;
      const props: NotebookGraphFixtureProps = {
        navigator: {
          notebookId,
          notebookName: notebook.name,
          notebookIcon: null,
          selectedNoteId: selected,
          currentHref: selected ? `/app/notebooks/${notebookId}/notes/${selected}?mode=book` : `/app/notebooks/${notebookId}?mode=book`,
          canWrite: false,
          locked: false,
          navigationHidden: false,
          tree: tree(graph),
          tags: [],
          current: "graph",
          graphBack: url.searchParams.get("back") ?? undefined,
        },
        graph,
        view: parseGraphViewState(url.searchParams),
        now: FIXTURE_NOW,
        from: url.searchParams.get("from") === "book" ? "book" : undefined,
      };
      const html = renderToString(() => createComponent(NotebookGraphFixture, props));
      return page(
        html,
        `<script id="graph-props" type="application/json">${JSON.stringify(props).replace(/</g, "\\u003c")}</script><script src="/harness.js"></script>`,
      );
    },
  });
}
