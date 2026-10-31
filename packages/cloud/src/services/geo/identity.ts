import type { AppPwaActor } from "../../app-pwa/contracts";
import type { AccessSubject, CapabilityAppExecutionContext, RequestActor } from "../../contracts";
import { GeoError } from "./errors";

export type GeoContext = {
  actor?: RequestActor | CapabilityAppExecutionContext["actor"];
  accessSubject?: AccessSubject | { type: "none" };
  locale?: string;
  signal?: AbortSignal;
  requestId?: string;
};
export type GeoBudgetSubject = AccessSubject | { type: "app"; appId: string };
export type AppPwaGeoContext = { actor: AppPwaActor; locale?: string; signal?: AbortSignal; requestId?: string };
export type GeoCallContext = GeoContext | AppPwaGeoContext;
export const geoIdentity = (
  context: GeoContext,
): {
  actor: RequestActor | CapabilityAppExecutionContext["actor"];
  accessSubject: GeoBudgetSubject;
} => {
  const { actor, accessSubject } = context;
  if (actor?.kind === "app" && actor.keyId && accessSubject?.type === "none")
    return { actor, accessSubject: { type: "app", appId: actor.appId } };
  if (
    !actor ||
    actor.kind === "app" ||
    !accessSubject ||
    accessSubject.type === "none" ||
    !(actor.kind === "user" ? actor.user?.id : actor.serviceAccount?.id) ||
    !(accessSubject.type === "user" ? accessSubject.userId : accessSubject.serviceAccountId)
  )
    throw new GeoError("GEO_FORBIDDEN");
  return { actor, accessSubject };
};
export const geoCallIdentity = (
  context: GeoCallContext,
): {
  actor: RequestActor | CapabilityAppExecutionContext["actor"] | AppPwaActor;
  accessSubject: GeoBudgetSubject;
} => {
  if (context.actor?.kind === "device" || context.actor?.kind === "visit") {
    if (!context.actor.ownerUserId) throw new GeoError("GEO_FORBIDDEN");
    return { actor: context.actor, accessSubject: { type: "user", userId: context.actor.ownerUserId } };
  }
  return geoIdentity({ actor: context.actor, accessSubject: "accessSubject" in context ? context.accessSubject : undefined });
};
