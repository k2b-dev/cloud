import { isPanelContextMessage } from "../contracts/panel-context-plain";
import type { HelpShortcut } from "../ssr/layout-help-start";
import { PANEL_SHORTCUTS_CHANGED, PANEL_SHORTCUTS_ELEMENT, readProviderContext } from "./panel-context-bridge";

/** Only platform Help code imports this module; third-party providers never receive a list. */
export function readPanelShortcuts(): HelpShortcut[] {
  if (typeof document === "undefined") return [];
  try {
    const shortcuts: unknown = JSON.parse(document.getElementById(PANEL_SHORTCUTS_ELEMENT)?.textContent ?? "[]");
    const message = {
      type: "cloud.panel.context",
      v: 1,
      context: readProviderContext(),
      shortcuts,
    };
    return isPanelContextMessage(message) ? (message.shortcuts ?? []) : [];
  } catch {
    return [];
  }
}

export function panelShortcutsReceived(): boolean {
  if (typeof document === "undefined") return false;
  return document.getElementById(PANEL_SHORTCUTS_ELEMENT)?.hasAttribute("data-received") ?? false;
}

export function onPanelShortcutsChange(cb: (shortcuts: HelpShortcut[]) => void): () => void {
  const changed = () => cb(readPanelShortcuts());
  window.addEventListener(PANEL_SHORTCUTS_CHANGED, changed);
  return () => window.removeEventListener(PANEL_SHORTCUTS_CHANGED, changed);
}
