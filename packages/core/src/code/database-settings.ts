import { createSettingsAPI } from "@k2b/cloud/services";
import { validateNetworkAllowlist } from "@k2b/cloud/services/settings/validation";

/** Operator-owned RSQL connection, separate from numeric Code budgets. */
export const CODE_DATABASE_SETTINGS = {
  "core.code.rsql_url": {
    kind: "string",
    default: "",
    label: "Code database server URL",
    description: "RSQL server for Code databases. Configure before the first database call; retain this server while Code databases exist.",
    validate: (value: unknown) => {
      if (typeof value !== "string") return "Use an RSQL server URL.";
      if (!value) return undefined;
      try {
        const url = new URL(value);
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return undefined;
      } catch {}
      return "Use an HTTP or HTTPS RSQL server URL without credentials, query or fragment.";
    },
    presentation: {
      translations: {
        de: {
          label: "Code-Datenbankserver",
          description:
            "RSQL-URL für Code-Datenbanken. Vor dem ersten Datenbankaufruf konfigurieren; Server beibehalten, solange Code-Datenbanken bestehen.",
        },
      },
    },
  },
  "core.code.rsql_api_token": {
    kind: "secret",
    default: "",
    label: "Code database server token",
    description: "Server-side RSQL credential. Never sent to Code or the runner.",
    presentation: {
      translations: {
        de: {
          label: "Code-Datenbanktoken",
          description: "RSQL-Zugangsdaten auf dem Server. Werden nie an Code oder Runner weitergegeben.",
        },
      },
    },
  },
  "core.code.rsql_allowed_targets": {
    kind: "string_list",
    default: Array.of("rsql"),
    label: "Code database allowed targets",
    description: "Exact internal RSQL hosts, IPs or CIDRs allowed by the operator.",
    validate: validateNetworkAllowlist,
    presentation: {
      translations: {
        de: { label: "Erlaubte Code-Datenbankziele", description: "Vom Betreiber erlaubte interne RSQL-Hosts, IPs oder CIDRs." },
      },
    },
  },
} as const;

export const codeDatabaseSettings = createSettingsAPI<typeof CODE_DATABASE_SETTINGS>();
