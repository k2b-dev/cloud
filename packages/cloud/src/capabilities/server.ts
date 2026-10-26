import { resolveCapabilityActionWording, resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import type { CapabilityActionWording } from "../_internal/capability-sentences";
import { getApp, getCapability } from "../_internal/registry";
import { dispatchCapability } from "../api/capabilities";
import { CAPABILITY_MAX_REVIEW_RESPONSE_BYTES, CapabilityActionReviewDataSchema } from "../contracts/capabilities";
import type { RequestAuthority } from "../server";
import { canUseApp } from "../services/app-access";
import { resolveAppPresentation } from "../shared/app-presentation";
import { capabilityMessages } from "../shared/capability-messages";
import { DEFAULT_LOCALE, LOCALE_HEADER } from "../shared/locale";
import { readCapabilityResponse } from "./response";
import { type CapabilityCaller, callerRequest, coreOrigin, unavailable } from "./server-invoke";
import { combineCapabilitySignals } from "./signals";
import type { CapabilityCatalogAppClientResult, CapabilityInvocation, CapabilityReviewClientResult } from "./types";

export type { CapabilityActionWording } from "../_internal/capability-sentences";
export {
  type CapabilityCaller,
  invokeCapability,
  invokeCapabilityWithDataSchema,
  listCapabilityCatalog,
} from "./server-invoke";
export type {
  CapabilityCatalogApp,
  CapabilityCatalogAppClientResult,
  CapabilityCatalogClientResult,
  CapabilityClientResult,
  CapabilityInvocation,
  CapabilityReviewClientResult,
} from "./types";

export const getCapabilityCatalogApp = async (
  appId: string,
  locale?: string,
  authority: RequestAuthority | null = null,
): Promise<CapabilityCatalogAppClientResult> => {
  try {
    const [capability, registeredApp] = await Promise.all([getCapability(appId), getApp(appId)]);
    const presentedApp = registeredApp && locale ? resolveAppPresentation(registeredApp, locale) : registeredApp;
    return {
      ok: true,
      data:
        capability && registeredApp && (await canUseApp(authority, registeredApp))
          ? {
              appId: capability.appId,
              appName: presentedApp?.name ?? capability.appName,
              appIcon: capability.appIcon,
              appDescription: presentedApp?.description ?? capability.appDescription,
              manifest: locale
                ? resolveCapabilityManifestPresentation(capability.manifest, capability.presentation, locale)
                : capability.manifest,
            }
          : null,
    };
  } catch {
    return { ok: false, error: { code: "APP_UNAVAILABLE", message: capabilityMessages(locale).cloudUnavailable, status: 503 } };
  }
};

/**
 * How people read calls of one Action in a locale, from the live registry like the Assistant's own calls: its title,
 * the app's sentences, and the labelled fields of the generic sentence. Pass `sentences` and `fields` to the chat's
 * approval card, so an approval a script or app asks for reads like the same call in a chat. `null` for an unknown
 * app or Action.
 */
export const getCapabilityActionWording = async (
  appId: string,
  localId: string,
  locale?: string,
  authority: RequestAuthority | null = null,
): Promise<CapabilityActionWording | null> => {
  const registeredApp = await getApp(appId);
  if (!registeredApp || !(await canUseApp(authority, registeredApp))) return null;
  const capability = await getCapability(appId);
  const action = capability?.manifest.actions.find((candidate) => candidate.localId === localId);
  return capability && action ? resolveCapabilityActionWording(action, capability.presentation, locale ?? DEFAULT_LOCALE) : null;
};

export const reviewCapabilityAction = async <TInput = unknown>(
  invocation: Omit<CapabilityInvocation<TInput>, "kind" | "idempotencyKey">,
  caller: CapabilityCaller,
): Promise<CapabilityReviewClientResult> => {
  try {
    if (caller.authority) {
      if (caller.authorization || caller.cookie || caller.mandate || caller.transport)
        throw new Error("Use exactly one capability authority source");
      const request = await callerRequest(caller, "/api/capabilities/review", undefined, invocation.signal);
      const outcome = await dispatchCapability({
        request,
        kind: "actions",
        review: true,
        appId: invocation.appId,
        capabilityId: invocation.capabilityId,
        input: invocation.input,
        authority: caller.authority,
        locale: caller.locale ?? undefined,
        origin: caller.origin ?? "app",
      });
      return await readCapabilityResponse(
        outcome,
        CapabilityActionReviewDataSchema,
        CAPABILITY_MAX_REVIEW_RESPONSE_BYTES,
        combineCapabilitySignals(caller.signal, invocation.signal),
      );
    }
    const response = await (caller.transport ?? fetch)(
      new Request(
        await callerRequest(
          caller,
          `/api/capabilities/v1/actions/${encodeURIComponent(invocation.appId)}/${encodeURIComponent(invocation.capabilityId)}/review`,
          undefined,
          invocation.signal,
        ),
        { body: JSON.stringify({ input: invocation.input }) },
      ),
    );
    return await readCapabilityResponse(
      response,
      CapabilityActionReviewDataSchema,
      CAPABILITY_MAX_REVIEW_RESPONSE_BYTES,
      combineCapabilitySignals(caller.signal, invocation.signal),
    );
  } catch (cause) {
    return unavailable(cause, undefined, caller.locale ?? undefined);
  }
};

/** Authenticated continuation of a capability stream, with no app-specific URL handling. */
export async function transferCapabilityStream(
  stream: import("../contracts/capabilities").CapabilityStream,
  verb: import("./streams").CapabilityStreamVerb,
  caller: CapabilityCaller,
  body?: BodyInit,
): Promise<Response> {
  if (caller.mandate) throw new Error("Capability streams do not support background mandates yet");
  const path = `/api/capabilities/v1/streams/${verb}`;
  const headers = new Headers();
  headers.set("x-cloud-stream-id", stream.id);
  headers.set("content-type", "application/octet-stream");
  if (caller.locale) headers.set(LOCALE_HEADER, caller.locale);
  if (caller.authorization) headers.set("authorization", caller.authorization);
  if (caller.cookie) headers.set("cookie", caller.cookie);
  const request = new Request(new URL(path, await coreOrigin()), {
    method: "POST",
    headers,
    body,
    signal: caller.signal,
    // @ts-expect-error Streaming server request bodies require duplex.
    duplex: body instanceof ReadableStream ? "half" : undefined,
  });
  if (caller.authority) {
    if (caller.cookie || caller.authorization || caller.transport) throw new Error("Use one authority source");
    const { dispatchCapabilityStream } = await import("../api/capability-streams");
    return dispatchCapabilityStream(request, caller.authority, verb);
  }
  return caller.transport ? caller.transport(request) : fetch(request, { redirect: "error" });
}

export {
  CALENDAR_VIEW_MAX_RANGE_MS,
  type CalendarReadResult,
  CalendarReadResultSchema,
  type CalendarSelection,
  CalendarSourceErrorSchema,
  type CalendarSourceListEntry,
  CalendarSourceListEntrySchema,
  type CalendarSourceState,
  CalendarSourceStateSchema,
  type CalendarSourceSummary,
  CalendarSourceSummarySchema,
  CalendarViewRangeSchema,
  listCalendarSources,
  readCalendarEvents,
} from "./calendar-sources";
export {
  actionReview,
  type CapabilityReviewForms,
  capabilityReviewRememberScope,
  capabilityReviewView,
} from "./reviews";
