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
    "pulse.clickhouse_url": {
      kind: "url",
      default: "",
      label: "ClickHouse address",
      description: "HTTP or HTTPS address of the dedicated Pulse data store.",
      presentation: {
        translations: { de: { label: "ClickHouse-Adresse", description: "HTTP- oder HTTPS-Adresse des eigenen Pulse-Datenspeichers." } },
      },
    },
    "pulse.clickhouse_user": {
      kind: "string",
      default: "pulse_service",
      label: "ClickHouse service user",
      description: "Service user created by the setup script.",
      presentation: {
        translations: { de: { label: "ClickHouse-Dienstbenutzer", description: "Dienstbenutzer aus dem Einrichtungsskript." } },
      },
    },
    "pulse.clickhouse_password": {
      kind: "secret",
      default: "",
      label: "ClickHouse service password",
      description: "Password of the Pulse service user.",
      presentation: { translations: { de: { label: "ClickHouse-Dienstpasswort", description: "Passwort des Pulse-Dienstbenutzers." } } },
    },
  },
  openapi: "/api/pulse/openapi.json",
  routes: ["/api/pulse", "/app/pulse", "/admin/pulse"],
});

export const { ssr, plugin } = app;
