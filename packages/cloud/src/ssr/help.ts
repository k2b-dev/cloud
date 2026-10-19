import type { Context } from "hono";
import { buildHelpDocumentPayload } from "../server/help-payload";
import { getLocale } from "../server/locale";
import { createHelpReader } from "../services/help";
import type { HelpManifestResult } from "../services/help/types";
import { logger } from "../services/logging";
import type { HelpDocumentPayload } from "../shared/help";
import type { HelpArticleParts } from "./layout-help-article";
import { helpArticlePartsServer } from "./layout-help-article.server";
import { resolveCurrentApp } from "./app-appearance";
import { getRuntimeContext } from "./runtime";

const manifests = new WeakMap<object, HelpManifestResult | null>();
const failedContexts = new WeakSet<object>();
const log = logger("help:ssr");
export const getLayoutHelp = (c: object): HelpManifestResult | null => manifests.get(c) ?? null;
export const layoutHelpFailed = (c: object): boolean => failedContexts.has(c);

/** Help metadata for the current or an explicit app; `null` without a user or when the user may not see the app. */
export const preloadLayoutHelp = async (c: Context, appId?: string): Promise<HelpManifestResult | null> => {
  if (manifests.has(c)) return getLayoutHelp(c);
  if (!c.get("runtime") || !c.get("user")) return null;
  const id = appId ?? resolveCurrentApp(getRuntimeContext(c).apps, c.req.path)?.id;
  if (!id) return null;
  try {
    const manifest = await createHelpReader(getLocale(c), c.get("actor")).manifest(id);
    manifests.set(c, manifest);
    return manifest;
  } catch (error) {
    // An unavailable Help store must not prevent an unrelated application page from rendering.
    failedContexts.add(c);
    log.warn("Help metadata unavailable", { appId: id, error: error instanceof Error ? error.message : String(error) });
    manifests.set(c, null);
    return null;
  }
};

export type LayoutHelpArticle = { payload: HelpDocumentPayload; parts: HelpArticleParts };

/** An authorized initial article; failures leave the browser's on-demand reader available. */
export const preloadLayoutHelpArticle = async (c: Context, appId: string, documentId: string): Promise<LayoutHelpArticle | null> => {
  if (!c.get("user")) return null;
  try {
    const article = await createHelpReader(getLocale(c), c.get("actor")).read({ appId, documentId });
    if (!article) return null;
    const payload = buildHelpDocumentPayload(article, c.req.header("User-Agent") ?? "");
    return { payload, parts: helpArticlePartsServer(payload.html) };
  } catch (error) {
    log.warn("Help article unavailable", { appId, documentId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
};
