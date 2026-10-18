import type { PanelPageContext } from "./panel-context";

/**
 * The zod-free half of the panel context contract, for code on every page: islands and the slot markup must not
 * pull the schema into their first load (see the Mail first-load guard). Validation lives in ./panel-context.
 */
export const PANEL_CONTEXT_PARAM = "cloud_panel_context";

/** Core is the platform's own surface. Every other provider asks once per app. */
export const panelProviderNeedsConsent = (appId: string): boolean => appId !== "core";

/**
 * Only application-owned same-origin paths. The context must already be valid: Layout and the slot controller build
 * it from validated parts. Null also removes a caller-supplied reserved parameter.
 */
export function withPanelContext(href: string, context: PanelPageContext | null): string {
  if (!href.startsWith("/") || href.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(href))
    throw new Error("Expected a same-origin panel path");
  const url = new URL(href, "https://panel.invalid");
  url.searchParams.delete(PANEL_CONTEXT_PARAM);
  if (context) url.searchParams.set(PANEL_CONTEXT_PARAM, JSON.stringify(context));
  return `${url.pathname}${url.search}${url.hash}`;
}
