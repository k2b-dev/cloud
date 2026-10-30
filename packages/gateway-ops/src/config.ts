import { appAccess, defineApp } from "@k2b/cloud";
import { validateNetworkAllowlist } from "@k2b/cloud/services/settings/validation";
import { appEnv } from "./env";
import { natsDiagnosticsSettings } from "./observability/nats/settings";

const port = 3000;

export const app = defineApp({
  id: "gateway-ops",
  access: appAccess.roles(["admin"], {
    publicRoutes: [
      // The scraper and self-service notification API keep their specialized authorization.
      "/metrics",
      "/api/notifications",
      "/api/notifications/summary",
      "/api/notifications/:id",
      "/api/notifications/:id/resend",
    ],
  }),
  name: "Gateway",
  icon: "ti ti-route-scan",
  description: "Admin console for gateway operations, observability, and notifications.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        description: "Administration für Gateway-Betrieb, Systembeobachtung und Benachrichtigungen.",
        widgets: {
          health: { title: "Plattformzustand", description: "Ob alle Apps laufen, dazu der Verkehr am Gateway." },
          errors: { title: "Protokolle", description: "Fehler und Warnungen der letzten 24 Stunden." },
        },
        adminGroups: { gateway: "Gateway", observability: "Systembeobachtung" },
        adminLinks: {
          "/admin/observability/gateway": "Apps",
          "/admin/observability/gateway/routes": "Routen",
          "/admin/observability": "Übersicht",
          "/admin/observability/logs": "Protokolle",
          "/admin/observability/jobs": "Jobs",
          "/admin/observability/workflows": "Workflows",
          "/admin/observability/capabilities": "Capabilities",
          "/admin/observability/telemetry": "Telemetrie",
          "/admin/observability/metrics": "Metriken",
          "/admin/observability/postgres": "Postgres",
          "/admin/observability/valkey": "Redis",
          "/admin/observability/nats": "NATS",
          "/admin/observability/nats/sync": "Sync",
          "/admin/observability/alerts": "Webhooks",
          "/admin/observability/deliveries": "Benachrichtigungen",
        },
      },
    },
  },
  // Stone rather than red: the console uses red for failures and amber for
  // warnings throughout, so a red chrome carried the same hue as its own most
  // urgent signal. Cyan belongs to the AI accent, so a neutral stone stays clear
  // of both and reads as an instrument panel rather than an alarm.
  appearance: { accent: "#57534e", background: { from: "#78716c", to: "#57534e", angle: 135 } },
  basePath: "/admin/observability",
  baseUrl: `http://app-gateway-ops:${port}`,
  adminHref: "/admin/observability",
  adminNav: [
    {
      section: "observability",
      id: "gateway",
      label: "Gateway",
      links: [
        { href: "/admin/observability/gateway", icon: "ti-apps", label: "Apps" },
        { href: "/admin/observability/gateway/routes", icon: "ti-route", label: "Routes" },
      ],
    },
    {
      section: "observability",
      id: "observability",
      label: "Observability",
      links: [
        { href: "/admin/observability", icon: "ti-stethoscope", label: "Overview" },
        { href: "/admin/observability/logs", icon: "ti-list-details", label: "Logs" },
        { href: "/admin/observability/jobs", icon: "ti-activity", label: "Jobs" },
        { href: "/admin/observability/workflows", icon: "ti-route", label: "Workflows" },
        { href: "/admin/observability/capabilities", icon: "ti-plug-connected", label: "Capabilities" },
        { href: "/admin/observability/telemetry", icon: "ti-chart-line", label: "Telemetry" },
        { href: "/admin/observability/metrics", icon: "ti-plug", label: "Metrics" },
        { href: "/admin/observability/postgres", icon: "ti-database", label: "Postgres" },
        { href: "/admin/observability/valkey", icon: "ti-database", label: "Redis" },
        { href: "/admin/observability/nats", icon: "ti-server", label: "NATS" },
        { href: "/admin/observability/nats/sync", icon: "ti-arrows-exchange", label: "Sync" },
        { href: "/admin/observability/alerts", icon: "ti-webhook", label: "Webhooks" },
        { href: "/admin/observability/deliveries", icon: "ti-bell", label: "Notifications" },
      ],
    },
  ],
  nav: { href: "", section: "hidden", requiresRoles: ["admin"] },
  settings: {
    "gateway.webhook_allowed_targets": {
      kind: "string_list",
      default: [],
      label: "Health webhook allowed targets",
      description: "Exact internal hosts, IPs or CIDRs allowed for health webhooks. Changes apply to new deliveries.",
      envVariable: "GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS",
      envBootstrap: () => appEnv.$readPresent("GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS"),
      validate: validateNetworkAllowlist,
      presentation: {
        translations: {
          de: {
            label: "Erlaubte Health-Webhook-Ziele",
            description: "Exakte interne Hosts, IPs oder CIDRs für Health-Webhooks. Änderungen gelten für neue Zustellungen.",
          },
        },
      },
    },

    ...natsDiagnosticsSettings,
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
    {
      id: "health",
      path: "/api/gateway/widget/health",
      title: "Platform health",
      description: "Whether every app is running, and the traffic at the gateway.",
      sizes: ["small", "medium"],
      defaultSize: "small",
      suggest: true,
      requiresRoles: ["admin"],
      // Recommended before sizes existed; the dashboard reads it only to convert boards saved then.
      presentation: { defaultZone: "context" },
    },
    {
      id: "errors",
      path: "/api/logging/widget/errors",
      title: "Logs",
      description: "Errors and warnings of the last 24 hours.",
      sizes: ["small", "medium"],
      defaultSize: "small",
      requiresRoles: ["admin"],
      // Recommended before sizes existed; the dashboard reads it only to convert boards saved then.
      presentation: { defaultZone: "context" },
    },
  ],
  routes: ["/metrics", "/api/gateway", "/api/logging", "/api/notifications", "/admin/observability", "/public/gateway-ops"],
});

export const { ssr, plugin } = app;
