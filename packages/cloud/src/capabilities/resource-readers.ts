import { getProcessApplicationId } from "../_internal/process-identity";
import { getCapability } from "../_internal/registry";
import { env } from "../config/env";
import {
  CloudResourceRefSchema,
  ResourceManagersDataSchema,
  ResourceManagersInputSchema,
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
export const readResourcePrincipals = async (
  options: {
    ref: { type: string; id: string };
    principals: readonly ResourcePrincipal[];
    signal?: AbortSignal;
    locale?: string;
    requestId?: string;
  } & (
    | { container?: { type: string; id: string }; eventPlace?: undefined }
    /** Reserved for Code's event-place check (`packages/core/src/code/event-access.ts`); see #3539 below and the
     * `event-place-exception` repository check. */
    | { container?: never; eventPlace: true }
  ),
): Promise<ResourceReadersResult> => {
  const ref = CloudResourceRefSchema.parse(options.ref);
  if (!env.CLOUD_APP_KEY) return { state: "not_configured", reason: "no_credential" };
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
  const query = entry.manifest.queries.find((query) => query.localId === `${localType}.readable` && query.appOnly);
  if (!model?.readable || !query) return { state: "not_configured", reason: "no_readable" };
  const input = ResourceReadableInputSchema.parse({ id: ref.id, container: options.container, principals: options.principals });
  if (model.container) {
    // #3539: the one exception to the container rule. A Code event place is bound to the place, not to a container, so
    // the check asks the place itself. Only the provider's derived event-place reader answers that: its input has no
    // container, and it runs the type's ordinary reader as each principal, as event delivery already authorizes every
    // resource event (packages/cloud/src/services/app-events/deliver.ts:172). An explicit hook expects a container and
    // answers every other caller; a derived reader cannot check a container, so such a caller finds no reader.
    // A schema without readable properties answers neither question.
    const properties = query.inputSchema.properties;
    if (typeof properties !== "object" || properties === null || Array.isArray(properties))
      return { state: "not_configured", reason: "no_readable" };
    const takesContainer = "container" in properties;
    if (takesContainer === Boolean(options.eventPlace)) return { state: "not_configured", reason: "no_readable" };
    if (!options.eventPlace && input.container?.type !== `${appId}.${model.container}`)
      throw new Error("Reader check requires a reference to the declared container type");
  }
  const result = await invokeCapabilityWithDataSchema(
    { appId, capabilityId: `${localType}.readable`, kind: "query", input },
    ResourceReadableDataSchema,
    {
      workload: { appId: callerAppId },
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

/** Uses the application's own workload identity; never manufactures a recipient session. */
export async function listResourceManagers(options: {
  ref: { type: string; id: string };
  afterId?: string;
  userId?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const ref = CloudResourceRefSchema.parse(options.ref);
  const input = ResourceManagersInputSchema.parse({ id: ref.id, afterId: options.afterId, userId: options.userId, limit: options.limit });
  const callerAppId = getProcessApplicationId();
  if (!callerAppId || !env.CLOUD_APP_KEY || !env.CLOUD_CORE_INTERNAL_ORIGIN)
    throw new Error("Resource manager workload identity unavailable");
  const separator = ref.type.indexOf(".");
  const appId = ref.type.slice(0, separator),
    capabilityId = `${ref.type.slice(separator + 1)}.managers`;
  const entry = await getCapability(appId);
  if (!entry) throw new Error("Resource manager provider registry entry unavailable");
  // An optional contract absent from a healthy manifest cannot recover through retries.
  if (!entry.manifest.queries.some((query) => query.localId === capabilityId && query.appOnly)) return [];
  const result = await invokeCapabilityWithDataSchema({ appId, capabilityId, kind: "query", input }, ResourceManagersDataSchema, {
    workload: { appId: callerAppId },
    signal: options.signal,
  });
  if (!result.ok) throw new Error(`Resource manager resolution unavailable: ${result.error.code}`);
  return result.data.data.userIds;
}
