import { defineApp } from "@valentinkolb/cloud";
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
    "grids.max_file_size_mb": {
      kind: "number",
      label: "Max File Size",
      default: 10,
      description: "Maximum size per uploaded Grids file.",
    },
  },
  openapi: "/api/grids/openapi.json",
  // `/share/grids` hosts anonymous-friendly pages (public forms etc);
  // `/public/grids` is reserved for this app's generated CSS/assets.
  routes: ["/api/grids", "/app/grids", "/admin/grids", "/share/grids", "/public/grids", "/apps"],
});

export const { ssr, plugin } = app;
