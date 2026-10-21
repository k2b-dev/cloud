import type { PanelPageContext } from "../contracts/panel-context";
export { onPanelBeforeLeave } from "./panel-leave";
import {
  PAGE_CONTEXT_CHANGED,
  PAGE_CONTEXT_COLLECT,
  PANEL_CONTEXT_CHANGED,
  type PageContextCollection,
  type PageContextSource,
  readProviderContext,
} from "./panel-context-bridge";

export type PanelRequest = { action: "open"; provider: string; search?: string; accepted: boolean } | { action: "close" | "toggle" };

declare global {
  interface WindowEventMap {
    "cloud.panel.request": CustomEvent<PanelRequest>;
  }
}

/** Opens a visible provider. False leaves navigation with the caller when this page has no matching slot. */
export function openPanel(provider: string, options?: { search?: string }): boolean {
  const detail: PanelRequest = {
    action: "open",
    provider,
    search: typeof options?.search === "string" && options.search.length <= 2048 ? options.search : undefined,
    accepted: false,
  };
  window.dispatchEvent(new CustomEvent("cloud.panel.request", { detail }));
  return detail.accepted;
}

/** Closes the panel when it is open. */
export function closePanel(): void {
  if (window.parent !== window && document.querySelector("[data-cloud-panel-page]")) {
    window.parent.postMessage({ type: "cloud.panel.close" }, location.origin);
    return;
  }
  window.dispatchEvent(new CustomEvent<PanelRequest>("cloud.panel.request", { detail: { action: "close" } }));
}

/** Publish in a reactive effect; dispose the previous call when that source changes or unmounts. */
export function publishPageContext(context: PageContextSource): () => void {
  const source = { ...context, ...(context.scope ? { scope: { ...context.scope } } : {}) };
  const collect = (event: Event) => (event as CustomEvent<PageContextCollection>).detail.sources.push(source);
  window.addEventListener(PAGE_CONTEXT_COLLECT, collect);
  window.dispatchEvent(new Event(PAGE_CONTEXT_CHANGED));
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    window.removeEventListener(PAGE_CONTEXT_COLLECT, collect);
    window.dispatchEvent(new Event(PAGE_CONTEXT_CHANGED));
  };
}

/** The validated URL snapshot, then the most recent accepted host message. */
export function getContext(): PanelPageContext | null {
  return readProviderContext();
}

/** Called on each accepted change, including null on close or withdrawal. */
export function onContextChange(cb: (context: PanelPageContext | null) => void): () => void {
  const changed = () => cb(getContext());
  window.addEventListener(PANEL_CONTEXT_CHANGED, changed);
  return () => window.removeEventListener(PANEL_CONTEXT_CHANGED, changed);
}
