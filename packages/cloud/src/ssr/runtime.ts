/**
 * Runtime context helpers for SSR components.
 * Extracted from _core/runtime-helpers.ts — only the generic parts.
 */
import type { CloudRuntime } from "../contracts/app";
import { getLocale } from "../server/locale";
import { resolveAppPresentations } from "../shared/app-presentation";

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
