export type PanelHeading = "view" | "start";
export type PanelMode = "navigation" | "sheet";
export type PanelWatch = { mode: PanelMode; heading: PanelHeading; timeoutMs: number };
export type PanelEndState = { holds: boolean; state: string };

/** Shared by the browser init script and DOM tests; every condition describes visible content. */
export function panelEndState(mode: PanelMode, heading: PanelHeading): PanelEndState {
  const fail = (state: string) => ({ holds: false, state });
  const slot = document.querySelector<HTMLElement>("#cloud-panel");
  if (!slot) return fail("panel slot missing");
  if (slot.dataset.state !== "ready") return fail(`slot ${slot.dataset.state ?? "unknown"}; expected ready`);
  if (slot.dataset.provider !== "core") return fail("slot provider is not core");
  const canvas = document.querySelector(".cloud-app-canvas");
  if (canvas?.getAttribute(mode === "sheet" ? "data-panel-sheet" : "data-panel") !== "open") return fail(`${mode} panel is closed`);
  const frame = slot.querySelector<HTMLIFrameElement>('iframe[data-cloud-panel-frame="core"]');
  if (!frame?.isConnected) return fail("provider iframe missing or disconnected");
  const visible = (element: Element, view: Window) => {
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility === "visible" &&
      Number(style.opacity) > 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < view.innerHeight &&
      rect.left < view.innerWidth
    );
  };
  if (!visible(frame, window)) return fail("provider iframe hidden, empty or outside viewport");
  try {
    const doc = frame.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) return fail("provider contentDocument inaccessible");
    if (doc.documentElement.dataset.cloudPanelReady !== "core") return fail("provider ready mark missing");
    const selector =
      heading === "view"
        ? "[data-help-results] section[data-help-view] #help-start-view-title"
        : // The first start heading: "What do you want to do?" tiles or the first kind group, whichever the app has.
          "[data-help-results] :is([data-help-tasks], [data-help-group]) .help-start-heading";
    const title = doc.querySelector(selector);
    if (!title)
      return fail(
        `expected ${heading} heading missing${heading === "view" && doc.querySelector(":is([data-help-tasks], [data-help-group]) .help-start-heading") ? "; only start heading exists" : ""}`,
      );
    if (!title.textContent?.trim()) return fail(`expected ${heading} heading is empty`);
    if (!visible(title, view)) return fail(`expected ${heading} heading hidden, empty or outside frame viewport`);
    return { holds: true, state: `visible ${heading} heading` };
  } catch {
    return fail("provider contentDocument inaccessible");
  }
}

type PanelProbe = {
  arm: (watch: PanelWatch) => void;
  watch: PanelWatch | null;
  anchor: number | null;
  navigationGapMs: number | null;
  hitAt: number | null;
  iframeSeenAt: number | null;
  providerReadyMs: number | null;
  frameNavigationMs: number | null;
  providerResponseStartMs: number | null;
  providerTtfbMs: number | null;
  state: string;
  timedOut: string | null;
};
declare global {
  interface Window {
    __cloudPanelPerf: PanelProbe;
  }
}

/** Inject with panelEndState as an argument so the exact same function runs in tests and browsers. */
export function installPanelProbe(endState: typeof panelEndState) {
  if (window !== window.top) return;
  const key = "cloud-panel-perf-navigation";
  let generation = 0;
  let providerDocument: Document | null = null;
  const p: PanelProbe = {
    arm: () => {},
    watch: null,
    anchor: null,
    navigationGapMs: null,
    hitAt: null,
    iframeSeenAt: null,
    providerReadyMs: null,
    frameNavigationMs: null,
    providerResponseStartMs: null,
    providerTtfbMs: null,
    state: "not armed",
    timedOut: null,
  };
  window.__cloudPanelPerf = p;
  const frame = () => document.querySelector<HTMLIFrameElement>('#cloud-panel iframe[data-cloud-panel-frame="core"][src]');
  const seen = () => {
    if (p.watch && p.anchor !== null && p.iframeSeenAt === null && frame()?.getAttribute("src")) p.iframeSeenAt = performance.now();
  };
  const observer = new MutationObserver(seen);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  document.addEventListener("DOMContentLoaded", seen, { once: true });
  const readProvider = () => {
    const iframe = frame();
    try {
      const doc = iframe?.contentDocument;
      const view = doc?.defaultView;
      if (!doc || !view || view.location.href === "about:blank") return;
      if (doc !== providerDocument) {
        providerDocument = doc;
        p.providerReadyMs = p.frameNavigationMs = p.providerResponseStartMs = p.providerTtfbMs = null;
      }
      const offset = view.performance.timeOrigin - performance.timeOrigin;
      const navigation = view.performance.getEntriesByType("navigation")[0];
      // The document can be replaced by loadNow; only the currently connected provider counts.
      if (
        navigation &&
        "responseStart" in navigation &&
        typeof navigation.responseStart === "number" &&
        "requestStart" in navigation &&
        typeof navigation.requestStart === "number"
      ) {
        p.frameNavigationMs = offset;
        p.providerResponseStartMs = offset + navigation.responseStart;
        p.providerTtfbMs = navigation.responseStart - navigation.requestStart;
      }
      if (doc.documentElement.dataset.cloudPanelReady === "core" && p.providerReadyMs === null) p.providerReadyMs = performance.now();
    } catch {
      /* endState supplies the inaccessible-document diagnostic. */
    }
  };
  p.arm = (watch) => {
    const current = ++generation;
    p.watch = watch;
    providerDocument = null;
    p.anchor = watch.mode === "navigation" ? 0 : null;
    p.hitAt = p.iframeSeenAt = p.providerReadyMs = p.frameNavigationMs = p.providerResponseStartMs = p.providerTtfbMs = null;
    p.timedOut = null;
    p.state = "waiting for anchor";
    const armedAt = performance.now();
    seen();
    requestAnimationFrame(function tick() {
      if (generation !== current) return;
      seen();
      readProvider();
      const state = endState(watch.mode, watch.heading);
      p.state = state.state;
      const now = performance.now();
      const elapsed = now - (p.anchor ?? armedAt);
      if (elapsed > watch.timeoutMs) {
        const iframe = frame();
        p.timedOut = `${p.state}; slot=${document.getElementById("cloud-panel")?.dataset.state ?? "missing"}; iframe=${iframe?.src ?? "missing"}; providerReady=${p.providerReadyMs ?? "missing"}; elapsed=${Math.round(elapsed)} ms`;
        return;
      }
      if (p.anchor !== null && state.holds) {
        p.hitAt = now;
        return;
      }
      requestAnimationFrame(tick);
    });
  };
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isTrusted || p.watch?.mode !== "sheet" || p.anchor !== null || p.timedOut || p.hitAt !== null) return;
      if (!(event.target instanceof Element) || !event.target.closest('button[aria-controls="cloud-panel"]')) return;
      p.anchor = event.timeStamp;
    },
    { capture: true },
  );
  const stored = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  if (stored) {
    const record: unknown = JSON.parse(stored);
    if (
      record &&
      typeof record === "object" &&
      "heading" in record &&
      (record.heading === "view" || record.heading === "start") &&
      "assignEpoch" in record &&
      typeof record.assignEpoch === "number" &&
      "timeoutMs" in record &&
      typeof record.timeoutMs === "number"
    ) {
      p.navigationGapMs = performance.timeOrigin - record.assignEpoch;
      p.arm({ mode: "navigation", heading: record.heading, timeoutMs: record.timeoutMs });
    } else throw new Error("Invalid armed panel navigation");
  }
}
