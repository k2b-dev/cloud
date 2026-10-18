import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import type { PageOptions } from "../_internal/define-app";
import type { AnnouncementDisplayEntry } from "../contracts/announcements";
import type { RuntimeAppMeta } from "../contracts/app";
import type { RailSnapshot } from "../contracts/rail-preferences";
import type { User } from "../contracts/shared";
import type { LayoutAnnouncementsState } from "../server/middleware/settings";
import type { HelpDocumentManifest } from "../shared/help";
import type { RuntimeContext } from "./runtime";

const root = mkdtempSync(resolve(tmpdir(), "cloud-shell-budget-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const railSnapshot = await import("../services/rail-snapshot");
const settingsMiddleware = await import("../server/middleware/settings");
const help = await import("./help");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const { default: Layout } = await import("./Layout");
const { default: AdminLayout } = await import("./AdminLayout");
const { default: MinimalLayout } = await import("./MinimalLayout");
const { default: PwaLayout } = await import("./PwaLayout");

const apps: RuntimeAppMeta[] = Array.from({ length: 12 }, (_, index) => ({
  id: `app-${index}`,
  name:
    ["Dashboard", "Mail", "Contacts", "Grids", "Files", "Notebooks", "Calendar", "Assistant", "FAQ", "Pulse", "Tasks", "Tools"][index] ??
    `App ${index}`,
  icon: "ti ti-box",
  description: "Manage projects, documents and daily work in your team.",
  routes: [`/app/app-${index}`, `/admin/app-${index}`],
  nav: { href: `/app/app-${index}`, section: index < 8 ? "primary" : "more", requiresAuth: false },
  ...(index < 2 ? { panel: { href: `/app/app-${index}/panel`, label: `Panel ${index}`, icon: "ti ti-box" } } : {}),
  appearance: { accent: "#2563eb" },
  searchLinks: Array.from({ length: index < 6 ? 3 : 2 }, (_, link) => ({
    label: `Search destination ${index}-${link}`,
    description: "Find current work and settings for this application.",
    href: `/app/app-${index}/destination-${link}`,
    keywords: ["projects", "documents", "settings"],
  })),
  ...(index < 6
    ? {
        searchTags: ["project", "document"],
        searchHelp: "Search projects and documents by title, owner or content.",
        searchTagHelp: [
          { tag: "project", help: "Limit the results to projects." },
          { tag: "document", help: "Limit the results to documents." },
        ],
      }
    : {}),
}));
const documents: HelpDocumentManifest[] = Array.from({ length: 8 }, (_, index) => ({
  id: `app-0-topic-${index}`,
  title: `Help topic ${index}`,
  description: "Learn how to organize and share your team's work.",
  order: index,
  icon: "ti ti-help",
  searchUrl: "/api/help/apps/app-0/search",
  url: `/api/help/apps/app-0/documents/topic-${index}`,
}));
const banner: AnnouncementDisplayEntry = {
  id: "22222222-2222-4222-8222-222222222222",
  version: 4,
  kind: "banner",
  tone: "info",
  title: "Maintenance notice",
  bodyHtml: "<p>A planned maintenance window is coming.</p>",
  publishedAt: "2026-10-01T10:00:00Z",
  expiresAt: null,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-01T10:00:00Z",
  createdBy: null,
  updatedBy: null,
};

type Environment = {
  Variables: {
    runtime: RuntimeContext;
    user: User | undefined;
    page: PageOptions;
    railPreferences: RailSnapshot;
    announcements: LayoutAnnouncementsState;
    settings: { app: { name: string } };
  };
};
const app = defineApp({
  id: "shell-budget",
  name: "Shell budget",
  icon: "ti ti-layout",
  description: "Shell payload regression fixture",
  baseUrl: "http://shell-budget:3000",
  routes: ["/app/app-0", "/admin/app-0", "/minimal"],
});
const server = new Hono<Environment>()
  .use("*", async (c, next) => {
    c.set("runtime", { apps });
    if (c.req.query("signed") === "true") c.set("user", { ...person, roles: [...person.roles, "admin"] });
    c.set("settings", { app: { name: "Cloud" } });
    c.set("announcements", {
      banners: [banner],
      announcements: [],
      latestAnnouncementVersion: 0,
      cookieState: { seenAnnouncementVersion: 0, dismissedBannerVersions: [] },
    });
    await next();
  })
  .get("/admin/app-0", ...app.ssr<Environment>((c) => () => createComponent(AdminLayout, { c, title: "Settings", children: "Admin page" })))
  .get("/app/app-0", ...app.ssr<Environment>((c) => () => createComponent(Layout, { c, title: "Projects", children: "App page" })))
  .get(
    "/minimal",
    ...app.ssr<Environment>(
      (c) => () => createComponent(MinimalLayout, { c, preferences: c.req.query("preferences") !== "false", children: "Minimal page" }),
    ),
  )
  .get("/pwa", ...app.ssr<Environment>((c) => () => createComponent(PwaLayout, { c, title: "Projects", children: "Phone page" })));

const decodedProps = (html: string) =>
  [...html.matchAll(/\bdata-props="([^"]*)"/g)].map((match) =>
    (match[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  );

for (const path of [
  "/admin/app-0?signed=true",
  "/app/app-0?signed=true",
  "/app/app-0",
  "/minimal",
  "/minimal?preferences=false",
  "/pwa?signed=true",
  "/pwa",
]) {
  test(`${path} stays within four shell instances and 20 KiB of decoded props`, async () => {
    const spies = [
      spyOn(railSnapshot, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
      spyOn(settingsMiddleware, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
      spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
      spyOn(help, "getLayoutHelp").mockReturnValue(
        path.includes("signed=true")
          ? { documents, pageBase: "/help/apps/app-0", baseLocale: "en", locale: "en", manifestHash: "fixture-help" }
          : null,
      ),
    ];
    try {
      const response = await server.request(path);
      const html = await response.text();
      expect(response.status).toBe(200);
      const instances = [...html.matchAll(/<solid-(?:island|client)\b/g)].length;
      const sources = [...html.matchAll(/<script id="cloud-shell-data" type="application\/json">([^<]*)<\/script>/g)];
      const bytes = new TextEncoder().encode([...decodedProps(html), ...sources.map((match) => match[1] ?? "")].join("")).byteLength;
      expect(instances).toBeLessThanOrEqual(4);
      expect(bytes).toBeLessThanOrEqual(20 * 1024);
      if (path.startsWith("/app/") || path.startsWith("/admin/")) {
        expect(sources).toHaveLength(1);
        expect(html.split("Search destination 0-0")).toHaveLength(2);
        if (path.includes("signed=true")) expect(html).toContain('data-cloud-announcement-dismiss="4"');
      }
      console.info(`${path}: ${instances} shell instances, ${bytes} decoded bytes`);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
}
