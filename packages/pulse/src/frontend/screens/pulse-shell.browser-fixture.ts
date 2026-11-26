import { spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import type { RuntimeContext } from "@k2b/cloud/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import { stubRailSnapshot } from "../../../../../tests/fixtures/rail-snapshot";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

/**
 * The real Cloud shell (icon rail, tinted page, phone bar) around an empty `#root`, rendered by the public `Layout`
 * on the server, so the screens' pictures show a page as a person sees it. The screens mount into `#root` in the
 * browser; the shell itself stays as the server drew it.
 */
export async function renderPulseShell() {
  registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(resolve(tmpdir(), "pulse-shell-")) });
  const [{ defineApp }, { Layout }, settings, help] = await Promise.all([
    import("@k2b/cloud"),
    import("@k2b/cloud/ssr"),
    import("@k2b/cloud/server/middleware/settings"),
    import("@k2b/cloud/ssr/help"),
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
  const apps = [
    entry("pulse", "Pulse", "activity-heartbeat"),
    entry("files", "Dateien", "folder"),
    entry("mail", "Mail", "mail"),
    entry("spaces", "Spaces", "layout-kanban"),
    entry("grids", "Grids", "table"),
  ];
  const app = defineApp({ ...apps[0]!, baseUrl: "http://pulse:3000" });
  type Environment = { Variables: { runtime: RuntimeContext; user: User } };
  const routes = new Hono<Environment>()
    .use(async (c, next) => {
      c.set("runtime", { apps });
      c.set("user", person);
      await next();
    })
    .get(
      "*",
      ...app.ssr<Environment>(
        (c) => () =>
          createComponent(Layout, {
            c,
            fullWidth: true,
            ui: "v2",
            title: "Pulse",
            get children() {
              return createComponent(Dynamic, { component: "div", id: "root", class: "flex min-h-0 flex-1 flex-col" });
            },
          }),
      ),
    );
  return {
    /** The shell's page for an address, with `#root` where the screen goes, without the shell's scripts. */
    async page(address: string) {
      const response = await routes.request(address, { headers: { "accept-language": "de" } });
      if (response.status !== 200) throw new Error(`The shell answered ${response.status} for ${address}.`);
      // the shell stays as the server drew it: its islands and their module links do not load in these pictures
      return (await response.text())
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
        .replace(/<link\b[^>]*rel="modulepreload"[^>]*>/g, "");
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
