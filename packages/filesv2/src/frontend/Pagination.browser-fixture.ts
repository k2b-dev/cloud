import { readFileSync } from "node:fs";
import type { DirectoryView, WorkspaceSnapshot } from "./workspace-state";

const ui = new URL("../../../ui/", import.meta.url).pathname;
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", ui))).default;
const cssBuild = await Bun.build({
  entrypoints: [
    new URL("../styles/app.css", import.meta.url).pathname,
    new URL("../../../cloud/src/styles/global.css", import.meta.url).pathname,
  ],
  plugins: [tailwind],
  target: "browser",
});
if (!cssBuild.success) throw new AggregateError(cssBuild.logs, "Pagination CSS build failed");
const appCss = await cssBuild.outputs.find((output) => output.path.endsWith("app.css"))!.text();
const globalCss = await cssBuild.outputs.find((output) => output.path.endsWith("global.css"))!.text();

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./Pagination.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-upload-panel-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Pagination harness build failed");
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const assets: Record<string, [string, string | Buffer]> = {
  "/harness.js": ["text/javascript; charset=utf-8", harness],
  // As in Cloud: the app sheet first, @k2b/ui after it.
  "/app.css": ["text/css", appCss],
  "/styles.css": ["text/css", globalCss],
  "/plex.css": ["text/css", readFileSync(`${ui}dist/plex.css`, "utf8")],
  "/tabler.css": ["text/css", readFileSync(`${ui}dist/tabler.css`, "utf8")],
};

const base: DirectoryView["base"] = {
  id: "demo",
  name: "Projektatelier",
  area: "cloud",
  kind: "groups",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
const names = ["Angebot.pdf", "Besprechung.md", "Entwurf.txt", "Fotoliste.csv", "Inventar.xlsx", "Lieferplan.pdf"];
export function demoDirectory(after?: string): DirectoryView {
  const second = after === "next";
  return {
    base,
    path: "",
    next: second ? null : "next",
    loadedPages: 1,
    items: names.slice(second ? 3 : 0, second ? 6 : 3).map((name) => ({
      name,
      path: name,
      directory: false,
      size: 12000,
      modified: "2026-11-07T12:00:00Z",
      actions: { read: true, write: false, move: false, share: false },
    })),
  };
}
export const fixture = (request: Request): Response => {
  const url = new URL(request.url);
  if (url.pathname === "/api/filesv2/bases") return Response.json({ items: [base], issues: [], editor: null });
  if (url.pathname === "/api/filesv2/bases/demo/entries") {
    const page = demoDirectory(url.searchParams.get("after") ?? undefined);
    if (url.searchParams.get("type") === "directories") return Response.json({ ...page, items: [], next: null });
    return Response.json(page);
  }
  if (url.pathname === "/app/filesv2") {
    const directory = demoDirectory();
    if (Number(url.searchParams.get("pages")) > 1) {
      directory.items.push(...demoDirectory("next").items);
      directory.next = null;
      directory.loadedPages = 2;
    }
    const initial: WorkspaceSnapshot = {
      source: url.pathname + url.search,
      directory,
      selectedId: base.id,
      bases: { items: [base], issues: [], editor: null },
      errorCode: null,
      now: "2026-11-07T12:00:00Z",
    };
    return new Response(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="/plex.css"><link rel="stylesheet" href="/tabler.css"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/styles.css">
      <style>html,body,#root{height:100%;margin:0}</style></head><body class="k2b-ui" data-theme="light"><div id="root"></div>
      <script id="snapshot" type="application/json">${JSON.stringify(initial)}</script><script src="/harness.js"></script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  }
  const asset = assets[url.pathname] ?? (url.pathname.endsWith(".woff2") ? ["font/woff2", readFileSync(`${ui}dist${url.pathname}`)] : null);
  return asset
    ? new Response(typeof asset[1] === "string" ? asset[1] : new Uint8Array(asset[1]!), { headers: { "Content-Type": String(asset[0]) } })
    : new Response(null, { status: 404 });
};
if (import.meta.main) {
  if (Bun.argv.includes("--help")) {
    console.log("bun Pagination.browser-fixture.ts [port] — invented Files data for screenshots");
    process.exit(0);
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(Bun.argv[2] ?? 4291), fetch: fixture });
  console.log(server.url.href);
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      server.stop(true);
      process.exit(0);
    });
}
