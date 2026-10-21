/** Synthetic admin authority/data; real AdminLayout, page island, prompts and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString, ssr } from "solid-js/web";
import type { OutgoingMailState } from "./OutgoingMail.island";

const initial: OutgoingMailState = {
  profiles: [],
  apps: {
    defaultProfile: null,
    items: [
      {
        appId: "backoffice",
        name: "Backoffice",
        registered: true,
        declared: false,
        readDeclared: true,
        mode: "default",
        profiles: [],
        logApps: ["invoices", "legacy-crm"],
        logContentApps: ["invoices"],
      },
      {
        appId: "customers",
        name: "Customers",
        registered: true,
        declared: false,
        readDeclared: false,
        mode: "default",
        profiles: [],
        logApps: [],
      },
      {
        appId: "invoices",
        name: "Invoices",
        registered: true,
        declared: true,
        readDeclared: false,
        mode: "default",
        profiles: [],
        logApps: [],
      },
      { appId: "core", name: "Core", registered: true, declared: true, readDeclared: false, mode: "default", profiles: [], logApps: [] },
    ],
  },
  log: { filter: {}, retention: { contentDays: 90, recordDays: 365 }, page: { items: [], page: 1, perPage: 25, total: 0, hasNext: false } },
};
const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "demo-admin",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

export async function outgoingMailBrowserFixture() {
  const root = mkdtempSync(join(tmpdir(), "core-mail-real-host-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const { AdminLayout } = await import("@k2b/cloud/ssr");
  const { default: OutgoingMail } = await import("./OutgoingMail.island.tsx");
  const { outgoingMailMessages } = await import("./messages");
  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "OutgoingMail.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-mail-admin-fixture",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const transformed = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: transformed.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile real outgoing-mail page");
  const script = await bundle.outputs[0]!.text();
  const styles = await Promise.all(
    [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of styles) if (!build.success) throw new AggregateError(build.logs, "Could not compile page styles");
  const css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(styles.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  const publicDir = join(root, "public");
  await (await import("../../../../scripts/font-assets")).buildFontAssets(publicDir);
  await (await import("../../../../scripts/tabler-assets")).buildTablerIconAssets(publicDir);
  const pages = new Hono<{
    Variables: {
      runtime: CloudRuntime;
      user: User;
      settings: Record<string, unknown>;
      actor: undefined;
      panelConsent: undefined;
      railPreferences: undefined;
      announcements: undefined;
      page: { title?: string };
    };
  }>();
  pages.get("/admin/core/outgoing-mail", (c) => {
    const locale = c.req.query("locale") === "en" ? "en" : "de";
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", { apps: [{ id: "core", name: "Core", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] }] });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    const title = outgoingMailMessages.resolve([locale]).t.title;
    const body = renderToString(() =>
      createComponent(AdminLayout, {
        c,
        title,
        get children() {
          // Same app-rows as page.tsx; the extra element only identifies the test's mount target.
          return ssr(
            ['<div class="app-rows"><div id="outgoing-mail-fixture">', "</div></div>"],
            createComponent(OutgoingMail, { initial }),
          );
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${locale}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui">${body}<script type="application/json" id="outgoing-mail-fixture-data">${JSON.stringify(initial)}</script><script src="/fixture.js"></script></body></html>`,
    );
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname.startsWith("/public/")) {
        const path = resolve(root, `.${url.pathname}`);
        return path.startsWith(`${publicDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      // No accidental live fetch; tests provide controlled API responses in the browser.
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Synthetic fixture: service unavailable" }, { status: 503 });
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/admin/core/outgoing-mail`,
    initial,
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
