import { defineEnv, envList, envString } from "@k2b/cloud/config";

export const appEnv = defineEnv({
  GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS: {
    schema: envList,
    default: [],
    scope: "runtime",
    doc: "Deprecated: bootstraps `gateway.webhook_allowed_targets` once when no stored value exists; remove after `cld admin settings status --env` succeeds. Comma-separated host names, IP addresses and CIDR ranges on internal networks allowed for health webhooks; unset allows only public targets, an explicit value replaces this default, and invalid entries including `/0` are ignored with a bootstrap warning.",
  },
  NATS_ADMIN_SERVERS: {
    schema: envList,
    default: [],
    doc: "Deprecated: bootstraps gateway.nats_admin_servers once; configure NATS diagnostics in Administration instead.",
  },
  NATS_ADMIN_CREDS_FILE: {
    schema: envString,
    doc: "Deprecated: imports system-account .creds file contents into gateway.nats_admin_access at startup; do not combine with NATS_ADMIN_NKEY_SEED_FILE.",
  },
  NATS_ADMIN_NKEY_SEED_FILE: {
    schema: envString,
    doc: "Deprecated: imports the user NKey seed contents into gateway.nats_admin_access and selects the nkey format at startup.",
  },
  NATS_ADMIN_TLS_CA_FILE: {
    schema: envString,
    doc: "Deprecated: imports CA PEM contents into gateway.nats_admin_tls_ca at startup; no file path is stored.",
  },
});
