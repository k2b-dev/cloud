import { defineApp } from "@valentinkolb/cloud";

const port = parseInt(process.env.PORT ?? "3000", 10);

export const app = defineApp({
  id: "gateway-ops",
  name: "Gateway",
  icon: "ti ti-route-scan",
  description: "Admin console for gateway operations, observability, and notifications.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        description: "Administration für Gateway-Betrieb, Systembeobachtung und Benachrichtigungen.",
        adminGroups: { gateway: "Gateway", observability: "Systembeobachtung" },
        adminLinks: {
          "/admin/gateway/apps": "Apps",
          "/admin/gateway/routes": "Routen",
          "/admin/observability": "Übersicht",
          "/admin/observability/logs": "Protokolle",
          "/admin/observability/jobs": "Jobs",
          "/admin/observability/workflows": "Workflows",
          "/admin/observability/telemetry": "Telemetrie",
          "/admin/observability/metrics": "Metriken",
          "/admin/observability/postgres": "Postgres",
          "/admin/observability/redis": "Redis",
          "/admin/observability/sync": "Sync",
          "/admin/observability/alerts": "Webhooks",
          "/admin/observability/notifications": "Benachrichtigungen",
        },
      },
    },
  },
  // Petrol rather than red: the console uses red for failures and amber for
  // warnings throughout, so a red chrome carried the same hue as its own most
  // urgent signal. Deep cyan stays clear of every status colour — the blue
  // used for "running" is a much lighter tone — and reads as an instrument
  // panel rather than an alarm.
  appearance: { accent: "#155e75", background: { from: "#0e7490", to: "#155e75", angle: 135 } },
  basePath: "/admin/gateway",
  baseUrl: `http://app-gateway-ops:${port}`,
  adminHref: "/admin/gateway",
  adminNav: [
    {
      id: "gateway",
      label: "Gateway",
      links: [
        { href: "/admin/gateway/apps", icon: "ti-apps", label: "Apps" },
        { href: "/admin/gateway/routes", icon: "ti-route", label: "Routes" },
      ],
    },
    {
      id: "observability",
      label: "Observability",
      links: [
        { href: "/admin/observability", icon: "ti-stethoscope", label: "Overview" },
        { href: "/admin/observability/logs", icon: "ti-list-details", label: "Logs" },
        { href: "/admin/observability/jobs", icon: "ti-activity", label: "Jobs" },
        { href: "/admin/observability/workflows", icon: "ti-route", label: "Workflows" },
        { href: "/admin/observability/telemetry", icon: "ti-chart-line", label: "Telemetry" },
        { href: "/admin/observability/metrics", icon: "ti-plug", label: "Metrics" },
        { href: "/admin/observability/postgres", icon: "ti-database", label: "Postgres" },
        { href: "/admin/observability/redis", icon: "ti-database", label: "Redis" },
        { href: "/admin/observability/sync", icon: "ti-arrows-exchange", label: "Sync" },
        { href: "/admin/observability/alerts", icon: "ti-webhook", label: "Webhooks" },
        { href: "/admin/observability/notifications", icon: "ti-bell", label: "Notifications" },
      ],
    },
  ],
  nav: { href: "", section: "hidden", requiresRoles: ["admin"] },
  settings: {
    "gateway.health_check_schedule": {
      kind: "cron",
      label: "Health Check Schedule",
      default: "*/5 * * * *",
      description: "Cron schedule for evaluating global gateway health and health webhooks. Uses app.timezone.",
      presentation: {
        translations: {
          de: {
            label: "Health-Check-Zeitplan",
            description: "Cron-Zeitplan zur Auswertung des globalen Gateway-Zustands und der Health-Webhooks. Verwendet app.timezone.",
          },
        },
      },
    },
    "gateway.telemetry_event_retention_days": {
      kind: "number",
      label: "Request Event Retention",
      default: 14,
      description: "Days to retain individual gateway request events.",
      presentation: {
        translations: {
          de: {
            label: "Aufbewahrung von Anfrageereignissen",
            description: "Anzahl der Tage, für die einzelne Gateway-Anfrageereignisse aufbewahrt werden.",
          },
        },
      },
    },
    "gateway.telemetry_rollup_retention_days": {
      kind: "number",
      label: "Request Rollup Retention",
      default: 90,
      description: "Days to retain minute request rollups for SLO and trend calculations.",
      presentation: {
        translations: {
          de: {
            label: "Aufbewahrung von Anfrageaggregaten",
            description: "Anzahl der Tage, für die minutenweise Anfrageaggregate für SLO- und Trendberechnungen aufbewahrt werden.",
          },
        },
      },
    },
  },
  widgets: [
    { id: "health", path: "/api/gateway/widget/health", presentation: { defaultZone: "context" } },
    { id: "errors", path: "/api/logging/widget/errors", presentation: { defaultZone: "context" } },
  ],
  routes: [
    "/metrics",
    "/api/gateway",
    "/api/logging",
    "/api/notifications",
    "/admin/gateway",
    "/admin/observability",
    "/public/gateway-ops",
  ],
});

export const { ssr, plugin } = app;
