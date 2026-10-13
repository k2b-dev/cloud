import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import type { CloudRuntime, RuntimeAppMeta } from "@k2b/cloud/contracts/app";
import type { AuthContext } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "cloud-help-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: page } = await import("./registered.page");
const rail = await import("@k2b/cloud/services/rail-snapshot");
const settings = await import("@k2b/cloud/server/middleware/settings");
const snapshot = await import("@k2b/cloud/services/settings/snapshot");
const help = await import("@k2b/cloud/services/help");
const { defaultRailPreferences } = await import("@k2b/cloud/contracts/rail-preferences");
/** Invented signed-in person. */
const person: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "mmuster",
  roles: ["user", "local"],
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
const apps: CloudRuntime["apps"] = [
  ...["spaces", "timetrack", "restricted"].map<RuntimeAppMeta>((id) => ({
    id,
    name: id === "spaces" ? "Spaces" : "Timetrack",
    icon: "ti ti-apps",
    description: "Help fixture",
    routes: [`/app/${id}`],
    nav: { href: `/app/${id}`, section: "primary" },
    appearance: { accent: id === "spaces" ? "#16a34a" : "#d97706" },
    help: { manifestHash: id, pageBase: `/app/${id}/help`, baseLocale: "en" },
  })),
  { id: "core", name: "Core", icon: "ti ti-cloud", description: "Core", routes: ["/help"], nav: { href: "/help", section: "primary" } },
];
const server = new Hono<{ Variables: AuthContext["Variables"] & { runtime: CloudRuntime } }>()
  .use(async (c, next) => {
    c.set("user", person);
    c.set("runtime", { apps });
    await next();
  })
  .get("/help/apps/:appId", ...page)
  .get("/help/apps/:appId/:topic", ...page);

test("registered Help keeps the owning app's rail, canvas and localized way up", async () => {
  const spies = [
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(snapshot, "loadSnapshot").mockResolvedValue({ app: { name: "Cloud" } }),
    spyOn(help, "createHelpReader").mockImplementation((locale) => ({
      manifest: async (id) => {
        const app = apps.find((app) => app.id === id);
        return app?.help && id !== "restricted"
          ? {
              ...app.help,
              locale,
              documents: [
                { id: `${id}-start`, title: `${id} start`, order: 1, locale, url: `/api/help/${id}`, searchUrl: `/api/help/${id}/search` },
              ],
            }
          : null;
      },
      list: async () => [],
      search: async () => [],
      read: async () => null,
    })),
  ];
  try {
    for (const [id, accent, topic] of [
      ["spaces", "#16a34a", ""],
      ["timetrack", "#d97706", "/timetrack-start"],
    ]) {
      for (const locale of ["en", "de"]) {
        const response = await server.request(`/help/apps/${id}${topic}`, { headers: { "Accept-Language": locale } });
        const html = await response.text();
        expect(response.status).toBe(200);
        const railLinks = [...html.matchAll(/<a\b[^>]*class="rail-item[^>]*>/g)].map((match) => match[0]);
        expect(railLinks.filter((link) => link.includes('aria-current="page"'))).toHaveLength(1);
        expect(railLinks.find((link) => link.includes('aria-current="page"'))).toContain(`href="/app/${id}"`);
        expect(html).toContain(`--app-accent:${accent}`);
        const titleRow = html.match(/<div class="layout-page-head"[\s\S]*?<\/div>/)?.[0] ?? "";
        expect(titleRow).toContain(`href="/app/${id}"`);
        expect(titleRow).toContain(locale === "de" ? "Hilfe" : "Help");
        expect(html).toContain(`${id}-start`);
        for (const other of ["spaces", "timetrack", "restricted"].filter((other) => other !== id))
          expect(html).not.toContain(`${other}-start`);
      }
    }
    for (const id of ["restricted", "missing", "core"]) expect((await server.request(`/help/apps/${id}`)).status).toBe(404);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
