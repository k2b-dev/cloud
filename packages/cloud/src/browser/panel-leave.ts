/** Internal same-origin collection; no composer content crosses the provider boundary. */
const LEAVE = "cloud.panel.before-leave";
const CHECK = "cloud.panel.has-leave-guard";
type LeaveDecision = { allowed: boolean };

/** Ordinary same-origin links handled by the panel host; explicit browser actions stay native. */
export function panelLinkDestination(event: MouseEvent): URL | undefined {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
  const url = new URL(anchor.getAttribute("href")!, document.baseURI);
  if (url.origin !== location.origin) return;
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
  return url;
}

/**
 * Register before enabling editing. Return true only when all provider work is recoverable.
 * A veto keeps the current frame. Saving and retry belong to the provider; no transition is queued.
 */
export function onPanelBeforeLeave(guard: () => boolean): () => void {
  const collect = (event: Event) => {
    const decision = (event as CustomEvent<LeaveDecision>).detail;
    try {
      // Only explicit synchronous true permits leaving; throws and accidental Promises fail closed.
      if (guard() !== true) decision.allowed = false;
    } catch {
      decision.allowed = false;
    }
  };
  const registered = (event: Event) => event.preventDefault();
  // Islands start independently: editing and its links must be protected before PanelRuntime loads too.
  const click = (event: MouseEvent) => {
    if (window.parent === window || !document.querySelector("[data-cloud-panel-page]")) return;
    const url = panelLinkDestination(event);
    if (!url) return;
    event.preventDefault();
    window.parent.postMessage({ type: "cloud.panel.navigate", v: 1, href: url.href }, location.origin);
  };
  window.addEventListener(LEAVE, collect);
  window.addEventListener(CHECK, registered);
  document.addEventListener("click", click);
  return () => {
    window.removeEventListener(LEAVE, collect);
    window.removeEventListener(CHECK, registered);
    document.removeEventListener("click", click);
  };
}

export function hasPanelLeaveGuard(): boolean {
  return !window.dispatchEvent(new Event(CHECK, { cancelable: true }));
}

export function panelCanLeave(target: Window): boolean {
  // A cross-origin navigation already destroyed the provider document and its guards.
  // It cannot participate in this same-origin contract or keep the host's slot trapped.
  try {
    void target.document;
  } catch {
    return true;
  }
  const decision: LeaveDecision = { allowed: true };
  try {
    target.dispatchEvent(new CustomEvent<LeaveDecision>(LEAVE, { detail: decision }));
    return decision.allowed;
  } catch {
    return false;
  }
}
