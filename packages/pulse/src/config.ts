import { defineApp } from "@k2b/cloud";
import { SKILLS } from "./skills";

export const app = defineApp({
  id: "pulse",
  cli: { pulse: { module: "src/cli.ts", references: "src/cli-references" } },
  name: "Pulse",
  icon: "ti ti-activity-heartbeat",
  description: "Metrics, events, states, and realtime dashboards.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        description: "Metriken, Ereignisse, Zustände und Echtzeit-Dashboards.",
        adminGroups: { pulse: "Pulse" },
        adminLinks: { "/admin/pulse": "Datenspeicher" },
      },
    },
  },
  appearance: { accent: "#1e40af", background: { from: "#1d4ed8", to: "#4f46e5", angle: 135 } },
  basePath: "/app/pulse",
  baseUrl: "http://app-pulse:3000",
  nav: {
    href: "/app/pulse",
    match: "/app/pulse",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["user"],
  },
  skills: SKILLS,
  adminHref: "/admin/pulse",
  adminNav: [{ id: "pulse", label: "Pulse", links: [{ label: "Data store", href: "/admin/pulse", icon: "ti ti-database" }] }],
  settings: {
    // Address, service user and password are one encrypted value, written and read as a whole: three
    // separate settings would let a reader combine a new address with the old password.
    "pulse.clickhouse_connection": {
      kind: "secret",
      default: "",
      label: "ClickHouse connection",
      description: "Address, service user and password of the dedicated Pulse data store. Set under Administration -> Pulse -> Data store.",
      presentation: {
        translations: {
          de: {
            label: "ClickHouse-Verbindung",
            description:
              "Adresse, Dienst-Zugang und Passwort des eigenen Pulse-Datenspeichers. Einstellen unter Administration -> Pulse -> Datenspeicher.",
          },
        },
      },
    },
  },
  openapi: "/api/pulse/openapi.json",
  routes: ["/api/pulse", "/app/pulse", "/admin/pulse"],
});

export const { ssr, plugin } = app;
