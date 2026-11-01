import { appAccess, defineApp } from "@k2b/cloud";
import { validateNetworkAllowlist } from "@k2b/cloud/services/settings/validation";
import { appEnv } from "./env";
import { SKILLS } from "./skills";

export const app = defineApp({
  id: "assistant",
  access: appAccess.signedIn({
    publicRoutes: [
      "/_internal/assistant/tools/*",
      "/app/assistant/apps/:id/run",
      "/api/assistant/runner/app-assets",
      "/api/assistant/runner/chunks/:name",
      "/api/assistant/runner/:id",
      "/api/assistant/runner/:id/app",
      "/api/assistant/openapi.json",
    ],
  }),
  cli: { assistant: { module: "src/cli.ts", references: "src/cli-references" } },
  name: "Gustav",
  icon: "ti ti-moustache",
  description: "General-purpose AI assistant for writing, rewriting, summarizing, and questions.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Gustav",
        panelLabel: "Gustav",
        adminLinks: { "/admin/assistant": "Apps" },
        description: "KI-Assistent zum Schreiben, Überarbeiten, Zusammenfassen und Beantworten von Fragen.",
      },
    },
  },
  // Plum: away from Chat violet and the AI cyan.
  appearance: {
    accent: "#8e1b6f",
    background: {
      from: "#8e1b6f",
      to: "#62378d",
      angle: 135,
      strength: 14,
    },
  },
  adminHref: "/admin/assistant",
  adminNav: [
    { id: "studio", section: "ai", label: "Studio", links: [{ label: "Apps", href: "/admin/assistant", icon: "ti ti-app-window" }] },
  ],
  settings: {
    "assistant.rsql_allowed_targets": {
      adminWrite: "application",
      kind: "string_list",
      default: ["rsql"],
      label: "rsql allowed targets",
      description: "Exact internal rsql hosts, IPs or CIDRs. Changes apply to new requests.",
      envVariable: "ASSISTANT_RSQL_ALLOWED_TARGETS",
      envBootstrap: () => appEnv.$readPresent("ASSISTANT_RSQL_ALLOWED_TARGETS"),
      validate: validateNetworkAllowlist,
      presentation: {
        translations: {
          de: {
            label: "Erlaubte rsql-Ziele",
            description: "Exakte interne rsql-Hosts, IPs oder CIDRs. Änderungen gelten für neue Anfragen.",
          },
        },
      },
    },

    "assistant.storage_file_mib": {
      adminWrite: "application",
      kind: "number",
      default: 50,
      min: 1,
      max: 64,
      integer: true,
      label: "Maximum shared file size (MiB)",
      description: "Per Studio file. Changes apply to new writes; existing files remain readable. Maximum 64 MiB per bounded transfer.",
      presentation: {
        translations: {
          de: {
            label: "Maximale gemeinsame Dateigröße (MiB)",
            description:
              "Pro Studio-Datei. Gilt für neue Schreibvorgänge; bestehende Dateien bleiben lesbar. Maximal 64 MiB pro begrenztem Transfer.",
          },
        },
      },
    },
    "assistant.storage_total_mib": {
      adminWrite: "application",
      kind: "number",
      default: 250,
      min: 1,
      max: 1048576,
      integer: true,
      label: "Shared file storage per Studio resource (MiB)",
      description: "Separate from KV. No file count limit. Lowering this value does not delete existing data.",
      presentation: {
        translations: {
          de: {
            label: "Gemeinsamer Dateispeicher pro Studio-Ressource (MiB)",
            description: "Getrennt von KV. Keine Dateianzahlgrenze. Ein niedrigeres Limit löscht keine bestehenden Daten.",
          },
        },
      },
    },
    "assistant.rsql_url": {
      adminWrite: "application",
      kind: "string",
      default: "",
      label: "rsql server URL",
      presentation: { translations: { de: { label: "rsql-Serveradresse" } } },
    },
    "assistant.rsql_api_token": {
      adminWrite: "application",
      kind: "secret",
      default: "",
      label: "rsql API token",
      presentation: { translations: { de: { label: "rsql-API-Token" } } },
    },
  },
  basePath: "/app/assistant",
  baseUrl: "http://app-assistant:3000",
  skills: SKILLS,
  nav: {
    href: "/app/assistant",
    match: "/app/assistant",
    section: "primary",
    requiresAuth: true,
  },
  panel: { href: "/app/assistant/panel", label: "Gustav", icon: "ti ti-moustache", order: 0, code: true },
  openapi: "/api/assistant/openapi.json",
  routes: ["/api/assistant", "/app/assistant", "/public/assistant", "/admin/assistant"],
});

export const { ssr, plugin } = app;
