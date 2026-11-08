import { appAccess, defineApp } from "@k2b/cloud";
import { DEFAULT_SERVER, normalizeServer } from "@k2b/speedtest";
import { germanToolSearchDescriptions, germanToolSearchLabels, toolSearchLinks } from "./search-links";

export const app = defineApp({
  id: "tools",
  // These protocols validate their own credentials and never use Cloud session authority.
  sessionlessRoutes: ["/tools/api/webhooks/receive/:token", "/tools/api/webhooks/receive/:token/*"],
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
      "/tools/api/speedtest/config",
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
  settings: {
    "tools.speedtest_server": {
      kind: "url",
      default: DEFAULT_SERVER,
      label: "Speedtest server",
      description: "Anonymous measurement target. HTTPS, or HTTP on loopback. No Cloud credentials are sent.",
      validate: (value: unknown) => {
        try {
          normalizeServer(String(value));
        } catch {
          return "Use HTTPS, or HTTP on loopback, without credentials, query or fragment.";
        }
      },
      presentation: {
        translations: {
          de: {
            label: "Speedtest-Server",
            description: "Ziel für anonyme Messungen. HTTPS oder HTTP auf Loopback. Cloud-Zugangsdaten werden nicht übertragen.",
          },
        },
      },
    },
    "tools.speedtest_enabled": {
      kind: "boolean",
      default: true,
      label: "Enable speedtest",
      description: "Allow measurements from the Tools page and Cloud CLI using this installation's settings.",
      presentation: {
        translations: {
          de: {
            label: "Speedtest aktivieren",
            description: "Messungen über die Tools-Seite und die Cloud CLI mit den Einstellungen dieser Installation erlauben.",
          },
        },
      },
    },
  },
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
