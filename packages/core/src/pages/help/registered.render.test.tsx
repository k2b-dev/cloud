import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import type { CloudRuntime, RuntimeAppMeta } from "@k2b/cloud/contracts/app";
import type { AuthContext } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { fromJSON } from "seroval";

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
    c.set("actor", { kind: "user", user: person });
    c.set("runtime", { apps });
    await next();
  })
  .get("/help/apps/:appId", ...page)
  .get("/help/apps/:appId/:topic", ...page);

test("registered Help keeps the owning app's rail, canvas and localized way up", async () => {
  const articleReads: string[] = [];
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
      read: async ({ appId, documentId }) => {
        articleReads.push(`${appId}/${documentId}`);
        return {
          appId,
          documentId,
          appName: appId,
          title: `${appId} fixture article`,
          locale,
          manifestHash: appId,
          order: 1,
          kind: "task",
          needs: "edit",
          related: [],
          links: {},
          markdown: 'Server fixture lead.\n\n## Open sharing {icon="share"}\n\n:::steps\n1. Server fixture body.\n2. Confirm sharing.\n:::',
        };
      },
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
        if (topic) {
          expect(html).toContain('class="help-article-facts"');
          expect(html).toContain("Server fixture lead.");
          expect(html).toContain("Server fixture body.");
          // Only the serialized parts carry rendered HTML; Markdown and the DOM keep their own copy.
          expect(html.split(String.raw`Server fixture body.\\x3C/li>`).length - 1).toBe(1);
          expect(html.split("Server fixture body.").length - 1).toBe(3);
          const attribute = html.match(/data-props="([^"]*)" data-file="CoreLayoutHelp\.island\.tsx"/)?.[1];
          expect(attribute).toBeDefined();
          const decoded = attribute!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
          const props = fromJSON<{ initialArticle: { payload: Record<string, unknown> } }>(JSON.parse(decoded));
          expect("html" in props.initialArticle.payload).toBe(false);
          if (locale === "en") expect(html).toContain("2 steps");
          expect(html).not.toContain('data-state="loading"');
        } else expect(html).not.toContain("Server fixture lead.");
        for (const other of ["spaces", "timetrack", "restricted"].filter((other) => other !== id))
          expect(html).not.toContain(`${other}-start`);
      }
    }

    for (const topic of ["unknown-id", "UpperCase"]) {
      const html = await (await server.request(`/help/apps/spaces/${topic}`)).text();
      expect(html).not.toContain("data-help-article-head");
      expect(html).not.toContain("Server fixture lead.");
    }
    for (const id of ["restricted", "missing", "core"])
      for (const suffix of ["", `/${id}-start`]) expect((await server.request(`/help/apps/${id}${suffix}`)).status).toBe(404);
    expect(articleReads).toEqual(["timetrack/timetrack-start", "timetrack/timetrack-start"]);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
