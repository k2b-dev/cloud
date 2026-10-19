import type { CloudResourceRef } from "../contracts/capabilities";
import type { PanelPageContext } from "../contracts/panel-context";

export const PAGE_CONTEXT_COLLECT = "cloud.page-context.collect";
export const PAGE_CONTEXT_CHANGED = "cloud.page-context.changed";
export const PANEL_CONTEXT_CHANGED = "cloud.panel.context.changed";
export const PANEL_CONTEXT_ELEMENT = "cloud-panel-context";
export const PANEL_SHORTCUTS_ELEMENT = "cloud-panel-shortcuts";
export const PANEL_SHORTCUTS_CHANGED = "cloud.panel.shortcuts.changed";
export type PageContextSource = { scope?: CloudResourceRef };
export type PageContextCollection = { sources: PageContextSource[] };
export type PanelConsentRequest = { provider: string; allowed: boolean };
export type PanelState = { provider: string; appName: string; consent: boolean; allowed: boolean; saving: boolean; open: boolean };

declare global {
  interface WindowEventMap {
    "cloud.panel.consent": CustomEvent<PanelConsentRequest>;
    "cloud.panel.state": CustomEvent<PanelState>;
  }
}

/** Framework-validated SSR data, then receiver-validated messages. Shared DOM state survives independent bundles. */
export function readProviderContext(): PanelPageContext | null {
  if (typeof document === "undefined") return null;
  try {
    return JSON.parse(document.getElementById(PANEL_CONTEXT_ELEMENT)?.textContent ?? "null");
  } catch {
    return null;
  }
}
