/**
 * Runtime context helpers for SSR components.
 * Extracted from _core/runtime-helpers.ts — only the generic parts.
 */
import type { Context } from "hono";
import type { CloudRuntime } from "../contracts/app";
import { getLocale } from "../server/locale";
import { appAccessAuthority } from "../services/app-access";
import { discoverableApps } from "../services/app-discovery";
import { resolveAppPresentation, resolveAppPresentations } from "../shared/app-presentation";

export type RuntimeContext = CloudRuntime;

type RuntimeCarrier = {
  get: (key: any) => unknown;
};

/**
 * Reads the runtime context from a Hono request context.
 */
export const getRuntimeContext = (carrier: RuntimeCarrier): RuntimeContext => {
  const runtime = carrier.get("runtime");
  if (!runtime || typeof runtime !== "object" || !Array.isArray((runtime as RuntimeContext).apps)) {
    throw new Error("Runtime context is missing on request context");
  }
  return runtime as RuntimeContext;
};

/** Request-scoped runtime projection with only app-owned human presentation localized. */
export const getLocalizedRuntimeContext = (carrier: RuntimeCarrier & { req: { raw: { headers: Headers } } }): RuntimeContext => {
  const runtime = getRuntimeContext(carrier);
  const locale = getLocale(carrier as Parameters<typeof getLocale>[0]);
  return { ...runtime, apps: resolveAppPresentations(runtime.apps, locale) };
};

/** An app's name in the request locale while the app is registered; `fallback` (its stored base name) otherwise. */
export const localizedAppName = (
  carrier: RuntimeCarrier & { req: { raw: { headers: Headers } } },
  appId: string,
  fallback: string,
): string => {
  return appNameIn(carrier, appId, getLocale(carrier as Parameters<typeof getLocale>[0]), fallback);
};

/** An app's registered name in the locale of a recorded request. */
export const appNameIn = (carrier: RuntimeCarrier, appId: string, locale: string, fallback: string): string => {
  const runtime = carrier.get("runtime");
  const apps =
    runtime && typeof runtime === "object" && Array.isArray((runtime as RuntimeContext).apps) ? (runtime as RuntimeContext).apps : [];
  const app = apps.find((entry) => entry.id === appId);
  return app ? resolveAppPresentation(app, locale).name : fallback;
};

const displayApps = new WeakMap<object, RuntimeContext["apps"]>();

/** Called after route authentication, before page data and synchronous layouts render. Routing keeps the full runtime. */
export const preloadDisplayApps = async (c: Context): Promise<void> => {
  if (!c.get("runtime") || displayApps.has(c)) return;
  displayApps.set(c, await discoverableApps(appAccessAuthority(c), getRuntimeContext(c).apps));
};

/** Display-only projection. A caller outside the SSR adapter must preload declared app access first. */
export const getDisplayRuntimeContext = (carrier: RuntimeCarrier): RuntimeContext => {
  const runtime = getRuntimeContext(carrier);
  return { ...runtime, apps: displayApps.get(carrier) ?? runtime.apps.filter((app) => app.access === undefined) };
};
