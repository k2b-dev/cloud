import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "assistant",
  name: "Assistant",
  icon: "ti ti-sparkles",
  description: "General-purpose AI assistant for writing, rewriting, summarizing, and questions.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Assistent",
        adminLinks: {"/admin/assistant":"Apps und Skripte"},
        description: "KI-Assistent zum Schreiben, Überarbeiten, Zusammenfassen und Beantworten von Fragen.",
      },
    },
  },
  appearance: {
    accent: "#14b8a6",
    background: {
      from: "#14b8a6",
      to: "#3b82f6",
      angle: 135,
    },
  },
  adminHref: "/admin/assistant",
  adminNav: [{id:"studio",section:"ai",label:"Studio",links:[{label:"Apps and scripts",href:"/admin/assistant",icon:"ti ti-app-window"}]}],
  settings: {
    "assistant.storage_file_mib": { kind: "number", default: 50, min: 1, max: 64, integer: true,
      label: "Maximum shared file size (MiB)", description: "Per Studio file. Changes apply to new writes; existing files remain readable. Maximum 64 MiB per bounded transfer.",
      presentation: { translations: { de: { label: "Maximale gemeinsame Dateigröße (MiB)", description: "Pro Studio-Datei. Gilt für neue Schreibvorgänge; bestehende Dateien bleiben lesbar. Maximal 64 MiB pro begrenztem Transfer." } } } },
    "assistant.storage_total_mib": { kind: "number", default: 250, min: 1, max: 1048576, integer: true,
      label: "Shared file storage per Studio resource (MiB)", description: "Separate from KV. No file count limit. Lowering this value does not delete existing data.",
      presentation: { translations: { de: { label: "Gemeinsamer Dateispeicher pro Studio-Ressource (MiB)", description: "Getrennt von KV. Keine Dateianzahlgrenze. Ein niedrigeres Limit löscht keine bestehenden Daten." } } } },
    "assistant.rsql_url": {kind:"string",default:"",label:"rsql server URL",presentation:{translations:{de:{label:"rsql-Serveradresse"}}}},
    "assistant.rsql_api_token": {kind:"secret",default:"",label:"rsql API token",presentation:{translations:{de:{label:"rsql-API-Token"}}}},
  },
  basePath: "/app/assistant",
  baseUrl: "http://app-assistant:3000",
  nav: {
    href: "/app/assistant",
    match: "/app/assistant",
    section: "primary",
    requiresAuth: true,
  },
  openapi: "/api/assistant/openapi.json",
  routes: ["/api/assistant", "/app/assistant", "/public/assistant", "/admin/assistant"],
});

export const { ssr, plugin } = app;
