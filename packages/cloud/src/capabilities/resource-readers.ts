import { getProcessApplicationId } from "../_internal/process-identity";
import { getCapability } from "../_internal/registry";
import { getAppWorkloadCredential } from "../_internal/workload-credential";
import { env } from "../config/env";
import {
  CloudResourceRefSchema,
  type ResourcePrincipal,
  ResourceReadableDataSchema,
  ResourceReadableInputSchema,
} from "../contracts/capabilities";
import { invokeCapabilityWithDataSchema } from "./server-invoke";

export type ResourceReadersResult =
  | { state: "checked"; readable: ResourcePrincipal[] }
  | { state: "not_configured"; reason: "no_readable" | "no_credential" | "no_internal_origin" | "no_app_identity" | "not_admitted" };

/** Admission is temporary; consumers may schedule a bounded fresh check after this delay. */
export class ResourceReaderRateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super("Resource reader rate limited");
  }
}

/** An empty checked subset means not readable; an unavailable check throws for the caller's retry. */
export const readResourcePrincipals = async (options: {
  ref: { type: string; id: string };
  container?: { type: string; id: string };
  principals: readonly ResourcePrincipal[];
  signal?: AbortSignal;
  locale?: string;
  requestId?: string;
}): Promise<ResourceReadersResult> => {
  const ref = CloudResourceRefSchema.parse(options.ref);
  // Core issues the credential automatically; an explicit CLOUD_APP_CREDENTIAL override wins.
  const credential = getAppWorkloadCredential();
  if (!credential) return { state: "not_configured", reason: "no_credential" };
  if (!env.CLOUD_CORE_INTERNAL_ORIGIN) return { state: "not_configured", reason: "no_internal_origin" };
  const callerAppId = getProcessApplicationId();
  if (!callerAppId) return { state: "not_configured", reason: "no_app_identity" };
  options.signal?.throwIfAborted();
  const separator = ref.type.indexOf(".");
  const appId = ref.type.slice(0, separator);
  const localType = ref.type.slice(separator + 1);
  const entry = await getCapability(appId);
  if (!entry) throw new Error("Resource reader provider registry entry unavailable");
  const model = entry.manifest.resourceTypes?.find((model) => model.type === localType);
  if (!model?.readable || !entry.manifest.queries.some((query) => query.localId === `${localType}.readable` && query.appOnly))
    return { state: "not_configured", reason: "no_readable" };
  const input = ResourceReadableInputSchema.parse({ id: ref.id, container: options.container, principals: options.principals });
  if (model.container && input.container?.type !== `${appId}.${model.container}`)
    throw new Error("Reader check requires a reference to the declared container type");
  const result = await invokeCapabilityWithDataSchema(
    { appId, capabilityId: `${localType}.readable`, kind: "query", input },
    ResourceReadableDataSchema,
    {
      workload: { appId: callerAppId },
      authorization: `Bearer ${credential}`,
      signal: options.signal,
      locale: options.locale,
      requestId: options.requestId,
    },
  );
  if (!result.ok) {
    if (result.error.code === "APP_QUERY_NOT_ADMITTED") return { state: "not_configured", reason: "not_admitted" };
    if (result.error.code === "RATE_LIMITED") throw new ResourceReaderRateLimited(result.error.retryAfterMs ?? 60_000);
    throw new Error(`Resource reader check unavailable: ${result.error.code}`);
  }
  return { state: "checked", readable: result.data.data.readable };
};
