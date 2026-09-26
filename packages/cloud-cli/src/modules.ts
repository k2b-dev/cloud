import type { CloudCliModule } from "@k2b/cloud/cli";

type BuiltInModule = {
  /** English summary; `modules.test.ts` keeps it equal to the module's own summary. */
  summary: string;
  germanSummary: string;
  load: () => Promise<{ default: CloudCliModule }>;
};

/**
 * Built-in `cld` modules, in help order. `cld help` reads only the summaries;
 * a command imports just its own module, so startup does not pay for the rest.
 */
export const builtInModules = {
  account: {
    summary: "Manage the authenticated account, profile, personal API keys, and SSH keys.",
    germanSummary: "Eigenes Konto verwalten.",
    load: () => import("@k2b/cloud/cli/account"),
  },
  accounts: {
    summary: "Manage accounts, groups, requests, audit events, and service-account credentials.",
    germanSummary: "Konten, Gruppen und Zugriffe verwalten.",
    load: () => import("@k2b/cloud-app-accounts/cli"),
  },
  admin: {
    summary: "Inspect and operate Cloud administration surfaces.",
    germanSummary: "Cloud-Betrieb verwalten.",
    load: () => import("@k2b/cloud/cli/admin"),
  },
  "api-docs": {
    summary: "Inspect the live OpenAPI documentation published by Cloud apps.",
    germanSummary: "Registrierte HTTP-APIs untersuchen.",
    load: () => import("@k2b/cloud-app-api-docs/cli"),
  },
  apps: {
    summary: "List Cloud apps available to the current user.",
    germanSummary: "Installierte Anwendungen anzeigen.",
    load: () => import("@k2b/cloud/cli/apps"),
  },
  capabilities: {
    summary: "Discover and invoke versioned Cloud app capabilities.",
    germanSummary: "Registrierte Capabilities untersuchen und ausführen.",
    load: () => import("@k2b/cloud/cli/capabilities"),
  },
  assistant: {
    summary: "Chat with the Cloud Assistant and manage chats, scheduled tasks, files, personalization, and Projects.",
    germanSummary: "Mit Assistant arbeiten.",
    load: () => import("@k2b/cloud-app-assistant/cli"),
  },
  contacts: {
    summary: "Find and change contacts by ID or <book>:<name>, and manage contact books.",
    germanSummary: "Kontakte verwalten.",
    load: () => import("@k2b/cloud-app-contacts/cli"),
  },
  faq: {
    summary: "Manage FAQ entries.",
    germanSummary: "FAQ-Einträge verwalten.",
    load: () => import("@k2b/cloud-app-faq/cli"),
  },
  filesv2: {
    summary: "Work with personal and group files and administer storage.",
    germanSummary: "Dateien und Ablagen verwalten.",
    load: () => import("@k2b/cloud-app-filesv2/cli"),
  },
  grids: {
    summary:
      "Manage Grids bases, schema, records, forms, Apps, views, GQL, documents, templates, and workflows through the Grids HTTP API.",
    germanSummary: "Grids-Daten und -Konfiguration verwalten.",
    load: () => import("@k2b/cloud-app-grids/cli"),
  },
  "ipa-hosts": {
    summary: "Manage IPA hosts and hostgroups.",
    germanSummary: "FreeIPA-Hosts verwalten.",
    load: () => import("@k2b/cloud-app-ipa-hosts/cli"),
  },
  mail: {
    summary: "Read, triage, and answer Cloud Mail; configure and operate mailboxes.",
    germanSummary: "Mail verwalten.",
    load: () => import("@k2b/cloud-app-mail/cli"),
  },
  notebooks: {
    summary: "Read and write notes by ID or path, and mirror notebooks as Markdown folders.",
    germanSummary: "Notizbücher und Notizen verwalten.",
    load: () => import("@k2b/cloud-app-notebooks/cli"),
  },
  oauth: {
    summary: "Manage OAuth clients.",
    germanSummary: "OAuth-Clients verwalten.",
    load: () => import("@k2b/cloud-app-oauth/cli"),
  },
  pulse: {
    summary: "Inspect Pulse data and manage Pulse bases, sources, queries, and dashboards.",
    germanSummary: "Pulse-Daten und -Dashboards verwalten.",
    load: () => import("@k2b/cloud-app-pulse/cli"),
  },
  spaces: {
    summary: "List, add, and change tasks and events by ID or <space>:<title>.",
    germanSummary: "Spaces und Arbeitselemente verwalten.",
    load: () => import("@k2b/cloud-app-spaces/cli"),
  },
  tools: {
    summary: "Run local utilities such as passwords, encoding, hashes, QR codes, encryption, and speedtests.",
    germanSummary: "Lokale Cloud-Werkzeuge verwenden.",
    load: () => import("@k2b/cloud-app-tools/cli"),
  },
  venue: {
    summary: "Manage venues.",
    germanSummary: "Veranstaltungsorte verwalten.",
    load: () => import("@k2b/cloud-app-venue/cli"),
  },
} satisfies Record<string, BuiltInModule>;

export type BuiltInModuleName = keyof typeof builtInModules;

export const isBuiltInModuleName = (name: string): name is BuiltInModuleName => Object.hasOwn(builtInModules, name);
