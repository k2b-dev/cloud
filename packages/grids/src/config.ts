import { defineApp } from "@k2b/cloud";
import { NOTIFICATIONS } from "./notifications";

export const app = defineApp({
  id: "grids",
  name: "Grids",
  icon: "ti ti-table",
  description: "Flexible tables: bases, fields, records, views, forms.",
  presentation: {
    baseLocale: "en",
    translations: { de: { description: "Flexible Tabellen mit Bases, Feldern, Datensätzen, Ansichten und Formularen." } },
  },
  appearance: {
    accent: "#008f4c",
    background: {
      from: "#00a651",
      to: "#22c55e",
      angle: 135,
      strength: 28,
    },
  },
  basePath: "/app/grids",
  baseUrl: "http://app-grids:3000",
  notifications: NOTIFICATIONS,
  adminHref: "/admin/grids",
  nav: {
    href: "/app/grids?recent=true",
    match: "/app/grids",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  settings: {
    "grids.query_pool_size": {
      kind: "number",
      label: "Query pool size",
      default: 12,
      min: 1,
      integer: true,
      description: "Per Grids process. Changes take effect after restarting all Grids instances.",
      presentation: {
        translations: {
          de: {
            label: "Abfrage-Poolgröße",
            description: "Pro Grids-Prozess. Änderungen werden nach Neustart aller Grids-Instanzen wirksam.",
          },
        },
      },
    },
    "grids.query_concurrency": {
      kind: "number",
      label: "Concurrent queries (0 = pool size)",
      default: 0,
      min: 0,
      integer: true,
      description: "Limited to the query pool size per Grids process. Changes take effect after restarting all Grids instances.",
      presentation: {
        translations: {
          de: {
            label: "Parallele Abfragen (0 = Poolgröße)",
            description:
              "Auf die Abfrage-Poolgröße pro Grids-Prozess begrenzt. Änderungen werden nach Neustart aller Grids-Instanzen wirksam.",
          },
        },
      },
    },
    "grids.query_queue_limit": {
      kind: "number",
      label: "Queued queries",
      default: 64,
      min: 0,
      integer: true,
      description: "Per Grids process. Changes take effect after restarting all Grids instances.",
      presentation: {
        translations: {
          de: {
            label: "Wartende Abfragen",
            description: "Pro Grids-Prozess. Änderungen werden nach Neustart aller Grids-Instanzen wirksam.",
          },
        },
      },
    },
    "grids.query_queue_timeout_ms": {
      kind: "number",
      label: "Queue wait timeout (ms)",
      default: 1000,
      min: 1,
      integer: true,
      description: "Per Grids process. Changes take effect after restarting all Grids instances.",
      presentation: {
        translations: {
          de: {
            label: "Wartezeit in der Warteschlange (ms)",
            description: "Pro Grids-Prozess. Änderungen werden nach Neustart aller Grids-Instanzen wirksam.",
          },
        },
      },
    },
    "grids.max_file_size_mb": {
      kind: "number",
      label: "Max File Size",
      default: 10,
      description: "Maximum size per uploaded Grids file.",
      presentation: {
        translations: { de: { label: "Maximale Dateigröße", description: "Maximale Größe pro hochgeladener Grids-Datei." } },
      },
    },
  },
  openapi: "/api/grids/openapi.json",
  // `/share/grids` hosts anonymous-friendly pages (public forms etc);
  // `/public/grids` is reserved for this app's generated CSS/assets.
  routes: ["/api/grids", "/app/grids", "/admin/grids", "/share/grids", "/public/grids", "/apps"],
});

export const { ssr, plugin } = app;
