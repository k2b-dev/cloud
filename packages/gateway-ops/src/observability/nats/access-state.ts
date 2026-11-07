import * as settings from "@k2b/cloud/services/settings";
import { z } from "zod";

const valuesSchema = z.tuple([z.array(z.string()), z.string(), z.string(), z.string()]);
const keys = [
  "gateway.nats_admin_servers",
  "gateway.nats_admin_access_kind",
  "gateway.nats_admin_access",
  "gateway.nats_admin_tls_ca",
] as const;

/** One database statement keeps endpoint and access from different saves apart. */
export const readNatsAccess = async () => {
  const snapshot = await settings.readStates(keys);
  const states = keys.map((key) => {
    const state = snapshot.get(key);
    if (!state) throw new Error(`Missing NATS diagnostics setting: ${key}`);
    return state;
  });
  const [servers, kind, access, ca] = valuesSchema.parse(states.map((state) => state.value));
  const unreadable = {
    servers: states[0]!.stored === "unreadable",
    kind: states[1]!.stored === "unreadable",
    access: states[2]!.stored === "unreadable",
    ca: states[3]!.stored === "unreadable",
  };
  return {
    servers,
    kind,
    access,
    ca,
    unreadable,
    accessRequired: servers.length > 0 && (states[2]!.bindingMismatch === true || states[2]!.stored !== "readable"),
  };
};
