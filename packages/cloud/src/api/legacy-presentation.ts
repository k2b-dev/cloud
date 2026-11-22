import { legacyTableView } from "../ai/result-view";
import { validateBlocks } from "../blocks/validate";

/**
 * Cloud 0.83 replaced the result field `presentation` (a table hint) with `view`. Apps built on an older
 * `@k2b/cloud` still return it, so until this Cloud version Core accepts it instead of refusing the whole result.
 * Remove this module and its call in 0.86 (#3918).
 */
export const LEGACY_PRESENTATION_REMOVED_IN = "0.86";

export type LegacyPresentationOutcome = "mapped" | "dropped";

/**
 * Takes `presentation` out of a provider result. For a surface Core renders (`toView`), a result without a `view`
 * carries the table's view instead, the same one Cloud shows for stored results, when that view passes the result
 * view checks; otherwise the hint is dropped. Every other field stays for the strict result check.
 */
export function acceptLegacyPresentation(
  body: unknown,
  context: { appId: string; title: () => string; appPrefixes: readonly string[] | null; toView: boolean },
): { body: unknown; outcome?: LegacyPresentationOutcome } {
  if (body === null || typeof body !== "object" || Array.isArray(body) || !Object.hasOwn(body, "presentation")) return { body };
  const { presentation, ...rest } = body as Record<string, unknown>;
  if (!context.toView || Object.hasOwn(rest, "view")) return { body: rest, outcome: "dropped" };
  const view = legacyTableView(presentation, rest.data, context.title());
  // Without the app's registered routes, row links cannot be checked, and Core's later view check would refuse the result.
  if (!view || !context.appPrefixes) return { body: rest, outcome: "dropped" };
  try {
    validateBlocks(view.blocks, "result", { appId: context.appId, appPrefixes: context.appPrefixes, envelope: { ...rest, view } });
  } catch {
    return { body: rest, outcome: "dropped" };
  }
  return { body: { ...rest, view }, outcome: "mapped" };
}
