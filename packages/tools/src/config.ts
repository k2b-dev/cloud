import { appAccess, defineApp } from "@k2b/cloud";
import { germanToolSearchDescriptions, germanToolSearchLabels, toolSearchLinks } from "./search-links";

export const app = defineApp({
  id: "tools",
  access: appAccess.signedIn({
    publicRoutes: [
      "/tools",
      "/tools/mailto",
      "/tools/qr",
      "/tools/encoding",
      "/tools/uuid",
      "/tools/hash",
      "/tools/lorem",
      "/tools/color",
      "/tools/image-converter",
      "/tools/image",
      "/tools/encryption",
      "/tools/password",
      "/tools/speedtest",
      "/tools/webhooks",
      "/tools/api/speedtest/ping",
      "/tools/api/speedtest/download",
      "/tools/api/speedtest/upload",
      "/tools/api/speedtest/cli",
      "/tools/api/speedtest/cli.py",
      "/tools/api/webhooks/receive/:token",
      "/tools/api/webhooks/receive/:token/*",
      "/tools/api/openapi.json",
    ],
  }),
  cli: { tools: { module: "src/cli.ts", references: "src/cli-references" } },
  name: "Tools",
  icon: "ti ti-tools",
  description: "Utility tools for day-to-day work tasks.",
  searchLinks: [{ label: "Tools", href: "/tools", keywords: ["tools", "utilities", "werkzeuge"] }, ...toolSearchLinks],
  appearance: { accent: "#475569", background: { from: "#64748b" } },
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Werkzeuge",
        description: "Praktische Werkzeuge für alltägliche Aufgaben.",
        searchLinks: { "/tools": "Werkzeuge", ...germanToolSearchLabels },
        searchLinkDescriptions: germanToolSearchDescriptions,
      },
    },
  },
  basePath: "/tools",
  baseUrl: "http://app-tools:3000",
  nav: {
    href: "/tools",
    match: "/tools",
    section: "more",
  },
  openapi: "/tools/api/openapi.json",
  // Top-level `/tools` (no `/app/tools` for the legacy short URL).
  routes: ["/tools", "/public/tools"],
});

export const { ssr, plugin } = app;
