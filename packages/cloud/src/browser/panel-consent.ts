/**
 * Asks the shell to show its consent question for this provider again, such as when a provider page needs the page's
 * context it was not given. The person answers in the shell; the page only learns the result through
 * `onContextChange`. Does nothing outside an open panel or for a provider that needs no consent.
 */
export function askPanelConsent(): void {
  if (window.parent !== window && document.querySelector("[data-cloud-panel-page]"))
    window.parent.postMessage({ type: "cloud.panel.consent.ask", v: 1 }, location.origin);
}
