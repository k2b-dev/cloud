import { getCapability } from "../_internal/registry";
import { type CapabilityDispatchDependencies, dispatchCapability } from "../api/capabilities";
import { readCapabilityResponse } from "../capabilities/response";
import {
  ASSISTANT_PLACE_CONTEXT_MAX_BYTES,
  type AssistantPlaceResult,
  AssistantPlaceSchema,
  assistantPlaceIssues,
} from "../contracts/assistant-place";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CloudResourceRef,
  CloudResourceRefSchema,
  capabilityResultSchema,
  cloudResourceRefAppId,
} from "../contracts/capabilities";
import type { RequestActor, RequestAuthority } from "../server";
import { logger } from "../services/logging";
import { withoutAdminRole } from "../services/session/user";
import { LOCALE_HEADER } from "../shared/locale";

export type PlaceProviderOptions = {
  locale?: string;
  signal?: AbortSignal;
  dependencies?: CapabilityDispatchDependencies & { getCapability?: typeof getCapability; dispatch?: typeof dispatchCapability };
};

/** Trusted host only: dispatch the current provider as the person. Never cache this answer as authority. */
export const runPlaceProvider = async (
  actor: RequestActor,
  placeRef: CloudResourceRef,
  options: PlaceProviderOptions = {},
): Promise<AssistantPlaceResult> => {
  const unavailable = { unavailable: true } as const;
  const ref = CloudResourceRefSchema.safeParse(placeRef);
  if (actor.kind !== "user" || !ref.success) return unavailable;
  const appId = cloudResourceRefAppId(ref.data);
  try {
    options.signal?.throwIfAborted();
    const app = await (options.dependencies?.getCapability ?? getCapability)(appId);
    const type = app?.manifest.types.find((type) => `${appId}.${type.localId}` === ref.data.type);
    if (!app || !type?.assistant || assistantPlaceIssues(app.manifest, type.localId).length) return unavailable;
    const authority: RequestAuthority = {
      actor: actor.sessionKind === "app" ? { ...actor, user: withoutAdminRole(actor.user) } : actor,
      accessSubject: { type: "user", userId: actor.user.id },
      credentialKind: "session",
      scopes: [],
    };
    const headers = new Headers();
    if (options.locale) headers.set(LOCALE_HEADER, options.locale);
    const response = await (options.dependencies?.dispatch ?? dispatchCapability)({
      request: new Request("http://cloud.internal/api/ai/place", { method: "POST", headers, signal: options.signal }),
      appId,
      capabilityId: type.assistant.provider,
      kind: "queries",
      input: {},
      target: ref.data,
      authority,
      origin: "assistant",
      dependencies: options.dependencies,
    });
    const result = await readCapabilityResponse(response, capabilityResultSchema(AssistantPlaceSchema), CAPABILITY_MAX_RESULT_BYTES);
    if (!result.ok) return unavailable;
    const place = result.data.data;
    if (new TextEncoder().encode(place.context).byteLength > ASSISTANT_PLACE_CONTEXT_MAX_BYTES) return unavailable;
    const log = logger("ai:place");
    const subset = (ids: readonly string[], allowed: readonly string[], field: "tools" | "skills") => {
      const outside = [...new Set(ids.filter((id) => !allowed.includes(id)))];
      if (outside.length)
        log.warn("Dropped assistant place IDs outside the declared superset", { appId, type: type.localId, field, ids: outside });
      return [...new Set(ids.filter((id) => allowed.includes(id)))];
    };
    return {
      ...place,
      tools: subset(place.tools, type.assistant.tools, "tools"),
      skills: subset(place.skills, type.assistant.skills, "skills"),
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logger("ai:place").warn("Assistant place provider unavailable", { appId });
    return unavailable;
  }
};
