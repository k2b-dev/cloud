import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { User } from "../../src/contracts/shared";
import type { AuthContext } from "../../src/server/middleware/auth";
import type { RuntimeContext } from "../../src/ssr/runtime";

// This directory is a small Cloud app that answers with the platform's error pages. The server render gives each
// island the ID that the app's own build gives it, so both use this directory as their root.
const appRoot = import.meta.dir;
const { plugin } = createConfig({ rootDir: appRoot, componentRoots: [] });
Bun.plugin(plugin());

const { defineApp } = await import("../../src/_internal/define-app");

const app = defineApp({
  id: "error-probe",
  name: "Error Probe",
  icon: "ti ti-bug",
  description: "Error page probe",
  baseUrl: "http://error-probe:3000",
  routes: ["/app/error-probe"],
  appRoot,
});

/** Fictional person for the signed-in pages. */
const lea: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "lea",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Lea",
  sn: "Muster",
  displayName: "Lea Muster",
  mail: "lea@musterverein.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

const ui = resolve(appRoot, "../../../ui/dist");

/**
 * Serves `/missing` (404), `/broken` (503) and `/forbidden` (403) with the built islands and the global stylesheet.
 * `?as=lea` renders the page for a signed-in person.
 */
export const startErrorPageServer = async () => {
  const outdir = mkdtempSync(join(tmpdir(), "cloud-error-page-"));
  const islands = await Bun.build({ entrypoints: [join(appRoot, "src/entry.ts")], plugins: [app.plugin()], outdir });
  if (!islands.success) throw new AggregateError(islands.logs, "Could not build the islands.");
  const css = await Bun.build({ entrypoints: [resolve(appRoot, "../../src/styles/global.css")], plugins: [tailwind] });
  if (!css.success) throw new AggregateError(css.logs, "Could not compile the global stylesheet.");
  const globalCss = await css.outputs[0]!.text();
  const routes = new Hono<AuthContext & { Variables: { runtime: RuntimeContext; settings: { app: { name: string } } } }>()
    .get("/_ssr/*", (c) => new Response(Bun.file(join(outdir, "_ssr", basename(c.req.path)))))
    .get("/public/global.css", (c) => c.body(globalCss, 200, { "content-type": "text/css" }))
    .get("/public/tabler-icons.css", () => new Response(Bun.file(join(ui, "tabler.css"))))
    .get("/public/:file{tabler-icons-.+\\.woff2}", (c) => new Response(Bun.file(join(ui, c.req.param("file")))))
    // A fictional mark, so screenshots show a logo where the Cloud name sits.
    .get("/branding/logo", (c) =>
      c.body(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="8" fill="#0f766e"/><text x="14" y="19" font-family="sans-serif" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">M</text></svg>',
        200,
        { "content-type": "image/svg+xml" },
      ),
    )
    .use("*", async (c, next) => {
      c.set("runtime", { apps: [] });
      c.set("settings", { app: { name: "Musterverein Cloud" } });
      if (c.req.query("as") === "lea") c.set("user", lea);
      await next();
    })
    .get("/missing", (c) => app.ssr.error(c, 404))
    .get("/broken", (c) => app.ssr.error(c, 503))
    .get("/forbidden", (c) => app.ssr.error(c, 403));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routes.fetch });
  return {
    url: server.url.href,
    stop: () => {
      server.stop(true);
      rmSync(outdir, { recursive: true, force: true });
    },
  };
};
