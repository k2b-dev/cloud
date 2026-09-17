import { z } from "zod";
import { freeipa } from "../../server/services";
import type { IpaRpcResponse } from "../../server/services/freeipa/client";
import { FREEIPA_REQUEST_TIMEOUT_MS } from "../../server/services/freeipa/transport";
import { getFreeIpaConfig } from "../freeipa-config";

export type AccountIdentityReconciliation =
  | {
      state: "present";
      identity: { id: string | null; name: string; uidNumber: number | null; gidNumber: number | null };
      eligible: boolean;
    }
  | { state: "absent" }
  | { state: "unknown"; reason: "provider_disabled" | "provider_unavailable" | "invalid_response" | "identity_conflict" };
export type IdentityLookup = { kind: "users" | "groups"; name: string; signal?: AbortSignal };

const number = z
  .union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().positive().max(2_147_483_647));
const attributeNumber = z.array(number).length(1).optional();
const userRecord = z.object({ uid: z.array(z.string()).length(1), uidnumber: attributeNumber, gidnumber: attributeNumber });
const groupRecord = z.object({ cn: z.array(z.string()).length(1), gidnumber: attributeNumber });
const notFound = (response: IpaRpcResponse) =>
  response.error?.kind === "rpc" && response.error.code === 4001 && response.error.name === "NotFound";

// Exact show responses have no pagination or Cloud sync filter. Only the named
// upstream NotFound error proves absence; HTTP 404 and malformed success do not.
export function parseIdentityShow(input: IdentityLookup, response: IpaRpcResponse): AccountIdentityReconciliation {
  if (notFound(response)) return { state: "absent" };
  if (response.error)
    return { state: "unknown", reason: response.error.kind === "invalid_response" ? "invalid_response" : "provider_unavailable" };
  const parsed = input.kind === "users" ? userRecord.safeParse(response.result?.result) : groupRecord.safeParse(response.result?.result);
  if (!parsed.success) return { state: "unknown", reason: "invalid_response" };
  const record = parsed.data;
  const name = "uid" in record ? record.uid[0]! : record.cn[0]!;
  if (name !== input.name) return { state: "unknown", reason: "invalid_response" };
  const uidNumber = "uidnumber" in record ? (record.uidnumber?.[0] ?? null) : null;
  const gidNumber = record.gidnumber?.[0] ?? null;
  return {
    state: "present",
    identity: { id: null, name, uidNumber, gidNumber },
    eligible: gidNumber !== null && (input.kind === "groups" || uidNumber !== null),
  };
}

export const readUpstreamIdentity = async (
  input: IdentityLookup,
  deps = { config: getFreeIpaConfig, session: freeipa.session.getServiceSession, call: freeipa.client.call },
): Promise<AccountIdentityReconciliation> => {
  try {
    const timeout = AbortSignal.timeout(FREEIPA_REQUEST_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const config = await deps.config();
    signal.throwIfAborted();
    if (!config.enabled) return { state: "unknown", reason: "provider_disabled" };
    if (!config.configured) return { state: "unknown", reason: "provider_unavailable" };
    const ipaSession = await deps.session({
      url: config.url,
      serviceUser: config.serviceUser,
      servicePassword: config.servicePassword,
      signal,
    });
    signal.throwIfAborted();
    const query = async (method: string) => {
      signal.throwIfAborted();
      const response = await deps.call({
        url: config.url,
        ipaSession,
        method,
        args: [input.name],
        options: { all: true, no_members: true },
        signal,
      });
      signal.throwIfAborted();
      return response;
    };
    const result = parseIdentityShow(input, await query(input.kind === "users" ? "user_show" : "group_show"));
    if (input.kind !== "users" || result.state !== "absent") return result;
    // user_show includes preserved users, but staged users live in a separate
    // container and can retain a former account's data while awaiting activation.
    const staged = parseIdentityShow(input, await query("stageuser_show"));
    return staged.state === "present" ? { ...staged, eligible: false } : staged;
  } catch {
    return { state: "unknown", reason: "provider_unavailable" };
  }
};
