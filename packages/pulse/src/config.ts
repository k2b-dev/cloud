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
        adminLinks: { "/admin/pulse": "Pulse" },
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
  adminNav: [{ id: "pulse", label: "Pulse", links: [{ label: "Pulse", href: "/admin/pulse", icon: "ti ti-activity-heartbeat" }] }],
  settings: {
    "pulse.max_bases": {
      kind: "number",
      default: 200,
      min: 1,
      max: 9007199254740991,
      integer: true,
      label: "Maximum bases",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: { de: { label: "Maximale Bases", description: "Einstellen unter Administration -> Pulse -> Bases." } },
      },
    },
    "pulse.max_raw_retention_days": {
      kind: "number",
      default: 730,
      min: 1,
      max: 3650,
      integer: true,
      label: "Maximum raw retention (days)",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: {
          de: { label: "Maximale Rohdaten-Aufbewahrung (Tage)", description: "Einstellen unter Administration -> Pulse -> Bases." },
        },
      },
    },
    "pulse.default_values_per_minute": {
      kind: "number",
      default: 2000,
      min: 1,
      max: 9007199254740991,
      integer: true,
      label: "Default values per minute",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: { de: { label: "Standardwerte pro Minute", description: "Einstellen unter Administration -> Pulse -> Bases." } },
      },
    },
    "pulse.default_bytes_per_minute": {
      kind: "number",
      default: 5242880,
      min: 1,
      max: 9007199254740991,
      integer: true,
      label: "Default bytes per minute",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: { de: { label: "Standardbytes pro Minute", description: "Einstellen unter Administration -> Pulse -> Bases." } },
      },
    },
    "pulse.default_storage_bytes": {
      kind: "number",
      default: 5000000000,
      min: 1,
      max: 9007199254740991,
      integer: true,
      label: "Default storage (bytes)",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: { de: { label: "Standardspeicher (Bytes)", description: "Einstellen unter Administration -> Pulse -> Bases." } },
      },
    },
    "pulse.default_max_series": {
      kind: "number",
      default: 50000,
      min: 1,
      max: 9007199254740991,
      integer: true,
      label: "Default maximum series",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: { de: { label: "Standardmaximum Serien", description: "Einstellen unter Administration -> Pulse -> Bases." } },
      },
    },
    "pulse.default_max_event_kinds": {
      kind: "number",
      default: 2000,
      min: 1,
      max: 9007199254740991,
      integer: true,
      label: "Default maximum event kinds",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: { de: { label: "Standardmaximum Ereignisarten", description: "Einstellen unter Administration -> Pulse -> Bases." } },
      },
    },
    "pulse.default_max_state_keys": {
      kind: "number",
      default: 2000,
      min: 1,
      max: 9007199254740991,
      integer: true,
      label: "Default maximum state keys",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: {
          de: { label: "Standardmaximum Zustandsschlüssel", description: "Einstellen unter Administration -> Pulse -> Bases." },
        },
      },
    },
    "pulse.base_creation": {
      kind: "enum",
      default: "everyone",
      options: [
        { value: "everyone", label: "People and agents" },
        { value: "people", label: "People" },
        { value: "admins", label: "Cloud admins" },
      ],
      label: "Who may create bases",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: {
          de: {
            label: "Wer Bases anlegen darf",
            description: "Einstellen unter Administration -> Pulse -> Bases.",
            options: { everyone: "Personen und Agenten", people: "Personen", admins: "Cloud-Admins" },
          },
        },
      },
    },
    "pulse.default_profile": {
      kind: "enum",
      default: "normal",
      options: [
        { value: "small", label: "Small" },
        { value: "normal", label: "Normal" },
        { value: "large", label: "Large" },
      ],
      label: "Default read profile",
      description: "Set under Administration -> Pulse -> Bases.",
      presentation: {
        translations: {
          de: {
            label: "Standard-Leseprofil",
            description: "Einstellen unter Administration -> Pulse -> Bases.",
            options: { small: "Klein", normal: "Normal", large: "Groß" },
          },
        },
      },
    },
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
