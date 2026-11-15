import type { SwapFallbackDetail } from "@k2b/ssr/nav";
import type { PageSwapFallbackReport } from "../contracts/page-swap-fallback";

/**
 * Counts page swaps that loaded the document instead, per app and reason, in Core's logs. The report leaves before
 * the document unloads and carries no URL, page content, or person.
 */
export const reportPageSwapFallbacks = (appId: string): (() => void) => {
  const report = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const { reason, status }: SwapFallbackDetail = event.detail;
    const body: PageSwapFallbackReport = { appId, reason, ...(status === undefined ? {} : { status }) };
    try {
      navigator.sendBeacon("/api/me/page-swap-fallbacks", new Blob([JSON.stringify(body)], { type: "application/json" }));
    } catch {
      // Diagnostics never stand in the way of the document load.
    }
  };
  window.addEventListener("ssr:nav-fallback", report);
  return () => window.removeEventListener("ssr:nav-fallback", report);
};
