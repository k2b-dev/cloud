import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { credsAuthenticator, nkeys } from "@nats-io/transport-node";
import { appEnv } from "../../env";

export type SystemAccessKind = "creds" | "nkey";

// Secret settings trim whitespace; the NATS parser requires a final delimiter newline.
export const credsContentAuthenticator = (contents: string) => credsAuthenticator(new TextEncoder().encode(`${contents}\n`));

/** Validate locally; broker permissions and JWT trust still belong to NATS. */
export const systemAccessKind = (value: string): SystemAccessKind | undefined => {
  let key: ReturnType<typeof nkeys.fromSeed> | undefined;
  try {
    if (value.trim().startsWith("SU")) {
      key = nkeys.fromSeed(new TextEncoder().encode(value.trim()));
      return key.getPublicKey().startsWith("U") ? "nkey" : undefined;
    }
    const auth = credsContentAuthenticator(value)("settings-validation");
    if (!auth || !("jwt" in auth) || !("nkey" in auth)) return undefined;
    const parts = auth.jwt.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    if (!claims || typeof claims !== "object" || !("sub" in claims) || claims.sub !== auth.nkey) return undefined;
    return auth.nkey?.startsWith("U") ? "creds" : undefined;
  } catch {
    return undefined;
  } finally {
    key?.clear();
  }
};

export const validateSystemAccess = (value: unknown): string | undefined =>
  typeof value === "string" && (value === "" || systemAccessKind(value))
    ? undefined
    : "System access must contain a NATS user .creds file or a user NKey seed.";

export const validateTlsCa = (value: unknown): string | undefined => {
  if (value === "") return undefined;
  if (typeof value !== "string") return "TLS CA must contain PEM certificates.";
  const certificates = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!certificates?.length || value.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim())
    return "TLS CA must contain PEM certificates.";
  try {
    for (const certificate of certificates) new X509Certificate(certificate);
    return undefined;
  } catch {
    return "TLS CA must contain valid PEM certificates.";
  }
};

const readBootstrapFile = (variable: "NATS_ADMIN_CREDS_FILE" | "NATS_ADMIN_NKEY_SEED_FILE" | "NATS_ADMIN_TLS_CA_FILE") => {
  const path = appEnv[variable];
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    console.warn(`[settings] cannot import ${variable} from "${path}"; NATS diagnostics bootstrap is disabled`);
    throw new Error(`Cannot import ${variable}`);
  }
};

/** A failed file import never enables a partial diagnostics configuration. */
export const natsDiagnosticsBootstrap = () => {
  if (appEnv.NATS_ADMIN_CREDS_FILE && appEnv.NATS_ADMIN_NKEY_SEED_FILE) {
    console.warn(
      "[settings] NATS_ADMIN_CREDS_FILE and NATS_ADMIN_NKEY_SEED_FILE are mutually exclusive; NATS diagnostics bootstrap is disabled",
    );
    throw new Error("Conflicting NATS diagnostics access files");
  }
  const creds = readBootstrapFile("NATS_ADMIN_CREDS_FILE");
  const seed = readBootstrapFile("NATS_ADMIN_NKEY_SEED_FILE");
  const ca = readBootstrapFile("NATS_ADMIN_TLS_CA_FILE");
  for (const [variable, invalid] of [
    ["NATS_ADMIN_CREDS_FILE", creds !== undefined && systemAccessKind(creds) !== "creds"],
    ["NATS_ADMIN_NKEY_SEED_FILE", seed !== undefined && systemAccessKind(seed) !== "nkey"],
    ["NATS_ADMIN_TLS_CA_FILE", ca !== undefined && (ca === "" || validateTlsCa(ca))],
  ] as const) {
    if (invalid) {
      console.warn(`[settings] invalid file contents for ${variable}; NATS diagnostics bootstrap is disabled`);
      throw new Error(`Invalid ${variable}`);
    }
  }
  return {
    servers: appEnv.NATS_ADMIN_SERVERS.length ? appEnv.NATS_ADMIN_SERVERS : undefined,
    kind: creds !== undefined ? "creds" : seed !== undefined ? "nkey" : undefined,
    access: creds ?? seed,
    ca,
  };
};

export const natsDiagnosticsSettings = {
  "gateway.nats_admin_access_kind": {
    kind: "enum",
    default: "creds",
    options: [
      { value: "creds", label: ".creds file content" },
      { value: "nkey", label: "NKey seed" },
    ],
    label: "System access format",
    description:
      "Choose the format of System access and replace its content when switching. Changes apply to the next diagnostics connection.",
    envVariable: "NATS_ADMIN_CREDS_FILE or NATS_ADMIN_NKEY_SEED_FILE",
    envBootstrap: () => natsDiagnosticsBootstrap().kind,
    presentation: {
      translations: {
        de: {
          label: "Format des Systemzugangs",
          description:
            "Format des Systemzugangs auswählen und beim Wechsel den Inhalt ersetzen. Änderungen gelten ab der nächsten Diagnoseverbindung.",
          options: { creds: "Inhalt einer .creds-Datei", nkey: "NKey-Seed" },
        },
      },
    },
  },
  "gateway.nats_admin_access": {
    kind: "secret",
    default: "",
    label: "System access",
    description:
      "Paste the system-account .creds file content or NKey seed. Stored encrypted. Changes apply to the next diagnostics connection.",
    envVariable: "NATS_ADMIN_CREDS_FILE or NATS_ADMIN_NKEY_SEED_FILE",
    envBootstrap: () => natsDiagnosticsBootstrap().access,
    validate: validateSystemAccess,
    presentation: {
      translations: {
        de: {
          label: "Systemzugang",
          description:
            "Inhalt der .creds-Datei oder NKey-Seed des Systemkontos einfügen. Wird verschlüsselt gespeichert. Änderungen gelten ab der nächsten Diagnoseverbindung.",
        },
      },
    },
  },
  "gateway.nats_admin_tls_ca": {
    kind: "text",
    default: "",
    label: "NATS diagnostics TLS CA",
    description:
      "Trusted CA certificate in PEM format. Leave empty for the default trust store. Changes apply to the next diagnostics connection.",
    envVariable: "NATS_ADMIN_TLS_CA_FILE",
    envBootstrap: () => natsDiagnosticsBootstrap().ca,
    validate: validateTlsCa,
    presentation: {
      translations: {
        de: {
          label: "TLS-CA für NATS-Diagnose",
          description:
            "Vertrauenswürdiges CA-Zertifikat im PEM-Format. Leer lassen für den Standard-Zertifikatsspeicher. Änderungen gelten ab der nächsten Diagnoseverbindung.",
        },
      },
    },
  },
  // Enable connections only after the other bootstrap entries have been stored.
  "gateway.nats_admin_servers": {
    kind: "string_list",
    default: [],
    label: "NATS diagnostics servers",
    description:
      "System-account server URLs. Leave empty to disable cluster diagnostics. Changes apply to the next diagnostics connection.",
    envVariable: "NATS_ADMIN_SERVERS",
    envBootstrap: () => natsDiagnosticsBootstrap().servers,
    presentation: {
      translations: {
        de: {
          label: "NATS-Diagnoseserver",
          description:
            "Server-URLs für das Systemkonto. Leer lassen, um die Clusterdiagnose abzuschalten. Änderungen gelten ab der nächsten Diagnoseverbindung.",
        },
      },
    },
  },
} as const;
