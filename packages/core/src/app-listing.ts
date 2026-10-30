import { readAppRegistrySnapshot } from "@k2b/cloud";
import { CapabilityAppIdSchema } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { createAppStatusReader, type ProviderRef } from "./app-status";
import { hideKnownApp, keepAppListingVisible, listingStatusProviders } from "./known-apps";

type ListingDependencies = {
  registry: typeof readAppRegistrySnapshot;
  forget: (params: {
    authority: RequestAuthority;
    appId: string;
    locale: string;
    signal?: AbortSignal;
    requiredProviders?: ProviderRef[];
  }) => Promise<{ failures: unknown[] }>;
  hide: typeof hideKnownApp;
  keepVisible: typeof keepAppListingVisible;
  providers: typeof listingStatusProviders;
};
const dependencies: ListingDependencies = {
  registry: readAppRegistrySnapshot,
  forget: (params) => createAppStatusReader().forgetAppStatus(params),
  hide: hideKnownApp,
  keepVisible: keepAppListingVisible,
  providers: listingStatusProviders,
};

export const removeAppListing = async (
  params: {
    authority: RequestAuthority;
    appId: string;
    locale: string;
    signal?: AbortSignal;
  },
  service: ListingDependencies = dependencies,
) => {
  const user = params.authority.actor.kind === "user" ? params.authority.actor.user : params.authority.actor.delegatedUser;
  if (!user?.roles.includes("admin") || params.authority.accessSubject.type !== "user" || params.authority.accessSubject.userId !== user.id)
    return { ok: false, error: "Administrator access required", status: 403, code: "FORBIDDEN" } as const;
  const credentialKind =
    params.authority.credentialKind === "invocation" ? params.authority.actor.delegation?.credentialKind : params.authority.credentialKind;
  if (credentialKind === "oauth" && !params.authority.scopes.some((scope) => scope === "write" || scope === "admin"))
    return { ok: false, error: "Write scope required", status: 403, code: "FORBIDDEN" } as const;
  const appId = CapabilityAppIdSchema.parse(params.appId);
  const german = params.locale.toLowerCase().startsWith("de");
  const running = () =>
    ({
      ok: false,
      error: german ? "Laufende Apps können nicht entfernt werden." : "Running apps cannot be removed.",
      status: 409,
      code: "app_running",
    }) as const;
  const unavailable = () =>
    ({
      ok: false,
      error: german ? "Nicht entfernt. Erneut versuchen." : "Not removed. Try again.",
      status: 503,
      code: "forget_failed",
    }) as const;
  try {
    const snapshot = await service.registry();
    if (snapshot.apps.some((app) => app.id === appId)) return running();
    if (snapshot.issues.length) return unavailable();
    params.signal?.throwIfAborted();
    await service.keepVisible(appId);
    const requiredProviders = await service.providers(appId);
    const forgotten = await service.forget({ ...params, appId, requiredProviders });
    if (forgotten.failures.length) return unavailable();
    // Re-read after provider effects so a restart during removal stays visible.
    const latest = await service.registry();
    if (latest.apps.some((app) => app.id === appId)) return running();
    if (latest.issues.length) return unavailable();
    params.signal?.throwIfAborted();
    await service.hide(appId);
    return { ok: true, data: { appId, hidden: true } } as const;
  } catch {
    return unavailable();
  }
};
