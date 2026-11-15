import type { SwapFallbackDetail } from "@k2b/ssr/nav";
import type { PageSwapFallbackReport } from "../contracts/page-swap-fallback";

/**
 * Counts page swaps that loaded the document instead, per app and reason, in Core's logs. The report outlives the
 * document unload (keepalive) and carries no URL, page content, or person: not in its body, and its Referer names
 * only the origin.
 */
export const reportPageSwapFallbacks = (appId: string): (() => void) => {
  const report = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const { reason, status }: SwapFallbackDetail = event.detail;
    const body: PageSwapFallbackReport = { appId, reason, ...(status === undefined ? {} : { status }) };
    // sendBeacon would send the full Referer with the current path and query. "no-referrer" would also turn the
    // Origin header into "null", which Cloud's Origin guard rejects for this cookie-authorized POST.
    void fetch("/api/me/page-swap-fallbacks", {
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      referrerPolicy: "origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {
      // Diagnostics never stand in the way of the document load.
    });
  };
  window.addEventListener("ssr:nav-fallback", report);
  return () => window.removeEventListener("ssr:nav-fallback", report);
};
