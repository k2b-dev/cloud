import type { Context } from "hono";
import { getLocale } from "../server/locale";
import { createHelpReader } from "../services/help";
import type { HelpManifestResult } from "../services/help/types";
import { logger } from "../services/logging";
import { resolveCurrentApp } from "./app-appearance";
import { getRuntimeContext } from "./runtime";

const manifests = new WeakMap<object, HelpManifestResult | null>();
const log = logger("help:ssr");
export const getLayoutHelp = (c: object): HelpManifestResult | null => manifests.get(c) ?? null;

/** Explicit Help pages also work anonymously; automatic layout loading requires a user. */
export const preloadLayoutHelp = async (c: Context, appId?: string): Promise<HelpManifestResult | null> => {
  if (manifests.has(c)) return getLayoutHelp(c);
  if (!c.get("runtime") || (!appId && !c.get("user"))) return null;
  const id = appId ?? resolveCurrentApp(getRuntimeContext(c).apps, c.req.path)?.id;
  if (!id) return null;
  try {
    const manifest = await createHelpReader(getLocale(c)).manifest(id);
    manifests.set(c, manifest);
    return manifest;
  } catch (error) {
    // An unavailable Help store must not prevent an unrelated application page from rendering.
    log.warn("Help metadata unavailable", { appId: id, error: error instanceof Error ? error.message : String(error) });
    manifests.set(c, null);
    return null;
  }
};
