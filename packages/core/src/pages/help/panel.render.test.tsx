import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "@k2b/cloud/contracts";
import type { CloudRuntime, RuntimeAppMeta } from "@k2b/cloud/contracts/app";
import { withPanelContext } from "@k2b/cloud/contracts/panel-context";
import type { AuthContext } from "@k2b/cloud/server";
import { helpMessages } from "@k2b/cloud/ssr/help-messages";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { fromJSON } from "seroval";

const root = mkdtempSync(join(tmpdir(), "cloud-help-panel-render-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: page } = await import("./panel.page");
const settings = await import("@k2b/cloud/server/middleware/settings");
const snapshot = await import("@k2b/cloud/services/settings/snapshot");
const rail = await import("@k2b/cloud/services/rail-snapshot");
const { defaultRailPreferences } = await import("@k2b/cloud/contracts/rail-preferences");
const help = await import("@k2b/cloud/services/help");
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

const apps: RuntimeAppMeta[] = ["spaces", "restricted", "admin-only", "core", "empty"].map((id) => ({
  id,
  name: `${id} fixture app`,
  icon: "ti ti-box",
  description: "Help fixture",
  routes: id === "core" ? ["/"] : [`/app/${id}`],
  ...(id === "admin-only"
    ? { adminHref: "/admin/fixture" }
    : { nav: { href: `/app/${id}`, section: "primary", ...(id === "restricted" ? { requiresRoles: ["admin"] } : {}) } }),
  appearance: { accent: "#16a34a", background: { from: "#16a34a", to: "#0284c7" } },
  ...(id !== "empty" ? { help: { manifestHash: id, pageBase: `/help/apps/${id}`, baseLocale: "en" } } : {}),
  ...(id === "core" ? { panel: { href: "/panel", label: "Help", icon: "ti ti-help-circle" } } : {}),
}));
const server = new Hono<{ Variables: AuthContext["Variables"] & { runtime: CloudRuntime } }>()
  .use(async (c, next) => {
    c.set("user", person);
    c.set("actor", { kind: "user", user: person });
    c.set("runtime", { apps });
    await next();
  })
  .get("/panel", ...page);
const panelUrl = (app: string, help = ["spaces-share", "unknown-id"]) =>
  withPanelContext("/panel", {
    v: 1,
    seq: 0,
    pageId: "22222222-2222-4222-8222-222222222222",
    app,
    help,
  });

// One reader stub preserves preloadLayoutHelp's actual failure tracking and request-local cache.
test("Help panel SSR authorizes selectors and renders the first view without shell chrome", async () => {
  const articleReads: string[] = [];
  const spies = [
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(snapshot, "loadSnapshot").mockResolvedValue({ app: { name: "Cloud" } }),
  ];
  let fail = false;
  const requestedApps: string[] = [];
  const reader = spyOn(help, "createHelpReader").mockImplementation((locale) => ({
    manifest: async (id) => {
      requestedApps.push(id);
      if (fail) throw new Error("Fixture metadata read failed");
      const app = apps.find((app) => app.id === id);
      return app?.help
        ? {
            ...app.help,
            locale,
            documents: [
              {
                id: `${id}-share`,
                title: `${id} fixture article`,
                order: 1,
                locale,
                kind: "task",
                url: `/api/help/${id}`,
                searchUrl: `/api/help/${id}/search`,
              },
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
  }));
  try {
    const response = await server.request(panelUrl("spaces"));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(html.match(/data-help-view(?:="")?[\s\S]*?<\/section>/)?.[0]).toContain('data-help-topic="spaces-share"');
    expect(html).not.toContain('data-help-topic="unknown-id"');
    expect(html).toContain("--app-canvas-from:#16a34a");
    expect(html).toContain('data-panel-provider="core"');
    for (const absent of ["rail-item", "cloud-app-canvas", 'id="cloud-panel"', "Help for spaces"]) expect(html).not.toContain(absent);
    for (const id of ["restricted", "admin-only", "nope"]) {
      const unavailable = await (await server.request(`${panelUrl(id)}&topic=${id}-share`)).text();
      expect(unavailable).toContain("This Help is not available");
      expect(unavailable).toContain("You may not have access to it, or it no longer exists.");
      expect(unavailable).not.toContain("fixture article");
      expect(unavailable).not.toContain("Server fixture lead.");
      expect(unavailable).not.toContain("fixture app");
      expect(unavailable).not.toContain("data-help-shortcuts");
      expect(unavailable).not.toContain("--app-accent:");
      expect(unavailable).not.toContain("data-help-search");
      expect(unavailable).not.toContain("data-help-menu");
    }
    expect(requestedApps).not.toContain("restricted");
    expect(requestedApps).not.toContain("nope");
    expect(requestedApps).not.toContain("admin-only");
    const core = await (await server.request("/panel")).text();
    expect(core).toContain("core fixture article");
    expect(core).not.toContain("spaces fixture article");
    const nullContext = await (await server.request("/panel?cloud_panel_context=null")).text();
    expect(nullContext).toContain("core fixture article");
    const duplicates = await (await server.request(panelUrl("spaces", ["spaces-share", "spaces-share", "unknown-id"]))).text();
    const viewSection = duplicates.match(/data-help-view(?:="")?[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(viewSection.match(/data-help-topic="spaces-share"/g)).toHaveLength(1);
    const empty = await (await server.request(panelUrl("empty"))).text();
    expect(empty).toContain("No Help articles here yet");
    for (const topic of ["spaces-share", "unknown-id", "UpperCase", "x".repeat(181)]) {
      const article = await (await server.request(`${panelUrl("spaces")}&topic=${topic}`)).text();
      expect(article.includes("data-help-article-head")).toBe(topic === "spaces-share");
      if (topic === "spaces-share") {
        expect(article).toContain('class="help-article-facts"');
        expect(article).toContain("Server fixture lead.");
        expect(article).toContain("Server fixture body.");
        // Only the serialized parts carry rendered HTML; Markdown and the DOM keep their own copy.
        expect(article.split(String.raw`Server fixture body.\\x3C/li>`).length - 1).toBe(1);
        expect(article.split("Server fixture body.").length - 1).toBe(3);
        const attribute = article.match(/data-props="([^"]*)" data-file="CoreLayoutHelpPanel\.island\.tsx"/)?.[1];
        expect(attribute).toBeDefined();
        const decoded = attribute!.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
        const props = fromJSON<{ initialArticle: { payload: Record<string, unknown> } }>(JSON.parse(decoded));
        expect("html" in props.initialArticle.payload).toBe(false);
        expect(article).toContain("2 steps");
        expect(article).not.toContain('data-state="loading"');
      } else expect(article).not.toContain("Server fixture lead.");
    }
    expect(articleReads).toEqual(["spaces/spaces-share"]);
    const german = await (
      await server.request(panelUrl("spaces"), {
        headers: { "Accept-Language": "de", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      })
    ).text();
    expect(german).toContain("Für diese Ansicht");
    expect(german).toContain("Was möchtest du tun?");
    expect(german).toContain("⌘");
    expect(helpMessages.resolve(["de"]).t.openAsPage).toBe("Als Seite öffnen");
    fail = true;
    const failed = await (await server.request(panelUrl("spaces"))).text();
    expect(failed).toContain("data-help-unavailable");
    expect(failed).toContain("Reload");
  } finally {
    reader.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
});
