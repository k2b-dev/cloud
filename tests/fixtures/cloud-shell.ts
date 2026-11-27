import { spyOn } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { User } from "../../packages/cloud/src/contracts";
import type { RuntimeContext } from "../../packages/cloud/src/ssr";
import { registerSsrTestPlugin } from "../../packages/ui/test/ssr-test-plugin";
import { stubRailSnapshot } from "./rail-snapshot";

/** One step of a page title, as `Layout` takes it. */
export type Crumb = { title: string; href?: string };

// Core serves the operator's logo at /branding/logo, and a picture has no Core: the shell's page carries Cloud's own
// logo in place of that address, so the rail and the phone bar show it instead of a broken image.
const logo = `data:image/svg+xml;base64,${readFileSync(resolve(import.meta.dir, "../../packages/cloud/public/logo.svg")).toString("base64")}`;

/**
 * The real Cloud shell (icon rail, tinted page, phone bar) around an empty `#root`, rendered by the public `Layout` on
 * the server, so pictures of an app's screens show a page as a person sees it. The screens mount into `#root` in the
 * browser; the shell itself stays as the server drew it. `app` is the open app; the rail lists it among a few others.
 */
export async function renderCloudShell(app: { id: string; name: string; icon: string }) {
  registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(resolve(tmpdir(), `${app.id}-shell-`)) });
  const [{ defineApp }, { Layout }, settings, help] = await Promise.all([
    import("../../packages/cloud/src"),
    import("../../packages/cloud/src/ssr"),
    import("../../packages/cloud/src/server/middleware/settings"),
    import("../../packages/cloud/src/ssr/help"),
  ]);
  const spies = [
    stubRailSnapshot(),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  ];
  const person: User = {
    id: "u-ada",
    uid: "ada",
    roles: ["user", "local", "local/user"],
    provider: "local",
    profile: "user",
    givenname: "Ada",
    sn: "Renz",
    displayName: "Ada Renz",
    mail: "ada@example.org",
    avatarHash: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
    ipa: null,
  };
  const entry = (id: string, name: string, icon: string) => ({
    id,
    name,
    description: name,
    icon: `ti ti-${icon}`,
    routes: [`/app/${id}`],
    nav: { href: `/app/${id}`, section: "primary" as const },
  });
  const others = [
    entry("files", "Dateien", "folder"),
    entry("mail", "Mail", "mail"),
    entry("spaces", "Spaces", "layout-kanban"),
    entry("grids", "Grids", "table"),
  ].filter((other) => other.id !== app.id);
  const apps = [entry(app.id, app.name, app.icon), ...others];
  const defined = defineApp({ ...apps[0]!, baseUrl: `http://${app.id}:3000` });
  // the page's own title (breadcrumbs), handed in per address, as the page renders it
  const titles = new Map<string, Crumb[]>();
  type Environment = { Variables: { runtime: RuntimeContext; user: User } };
  const routes = new Hono<Environment>()
    .use(async (c, next) => {
      c.set("runtime", { apps });
      c.set("user", person);
      await next();
    })
    .get(
      "*",
      ...defined.ssr<Environment>(
        (c) => () =>
          createComponent(Layout, {
            c,
            fullWidth: true,
            ui: "v2",
            get title() {
              return titles.get(c.req.url) ?? app.name;
            },
            get children() {
              return createComponent(Dynamic, { component: "div", id: "root", class: "flex min-h-0 flex-1 flex-col" });
            },
          }),
      ),
    );
  return {
    /** The shell's page for an address, with `#root` where the screen goes, without the shell's scripts. */
    async page(address: string, title: Crumb[]) {
      const url = new URL(address, `http://${app.id}.test`).href;
      titles.set(url, title);
      const response = await routes.request(url, { headers: { "accept-language": "de" } });
      if (response.status !== 200) throw new Error(`The shell answered ${response.status} for ${address}.`);
      // the shell stays as the server drew it: its islands and their module links do not load in these pictures
      return (await response.text())
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
        .replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, "")
        .replaceAll('src="/branding/logo"', `src="${logo}"`);
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
