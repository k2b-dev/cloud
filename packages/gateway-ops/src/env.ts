import { defineEnv, envList, envString } from "@k2b/cloud/config";

export const appEnv = defineEnv({
  NATS_ADMIN_SERVERS: {
    schema: envList,
    default: [],
    doc: "Optional comma-separated NATS system-account servers used only for Gateway Ops cluster diagnostics.",
  },
  NATS_ADMIN_CREDS_FILE: {
    schema: envString,
    doc: "Path to the mounted system-account `.creds` file for NATS diagnostics; do not combine with the NKey seed file.",
  },
  NATS_ADMIN_NKEY_SEED_FILE: {
    schema: envString,
    doc: "Path to a static system-account NKey seed file for NATS diagnostics; an alternative to the `.creds` file.",
  },
  NATS_ADMIN_TLS_CA_FILE: {
    schema: envString,
    doc: "Path to the CA certificate that enables TLS for the NATS diagnostics connection.",
  },
});
