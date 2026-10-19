import { isPanelContextMessage } from "../contracts/panel-context-plain";
import {
  PANEL_CONTEXT_CHANGED,
  PANEL_CONTEXT_ELEMENT,
  PANEL_SHORTCUTS_CHANGED,
  PANEL_SHORTCUTS_ELEMENT,
  readProviderContext,
} from "./panel-context-bridge";

/** Installed only by an embedded PanelRuntime; the public page publisher never imports validation. */
export function installPanelContextReceiver(): () => void {
  let element = document.getElementById(PANEL_CONTEXT_ELEMENT);
  if (!element) {
    element = document.createElement("script");
    element.id = PANEL_CONTEXT_ELEMENT;
    element.setAttribute("type", "application/json");
    element.textContent = "null";
    document.body.append(element);
  }
  let shortcutsElement = document.getElementById(PANEL_SHORTCUTS_ELEMENT);
  if (!shortcutsElement) {
    shortcutsElement = document.createElement("script");
    shortcutsElement.id = PANEL_SHORTCUTS_ELEMENT;
    shortcutsElement.setAttribute("type", "application/json");
    shortcutsElement.textContent = "[]";
    document.body.append(shortcutsElement);
  }
  const first = readProviderContext();
  let pageId = first?.pageId;
  let seq = first?.seq ?? 0;
  const receive = (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || event.origin !== location.origin || !isPanelContextMessage(event.data)) return;
    const context = event.data.context;
    if (context) {
      if ((pageId !== undefined && context.pageId !== pageId) || context.seq < seq) return;
      pageId = context.pageId;
      seq = context.seq;
    }
    // Null revokes the current context without forgetting document identity or ordering.
    const contextJson = JSON.stringify(context);
    const contextChanged = element.textContent !== contextJson;
    element.textContent = contextJson;
    const shortcuts = JSON.stringify(context ? (event.data.shortcuts ?? []) : []);
    const shortcutsChanged = shortcutsElement.textContent !== shortcuts;
    shortcutsElement.textContent = shortcuts;
    if (shortcutsChanged) window.dispatchEvent(new Event(PANEL_SHORTCUTS_CHANGED));
    if (contextChanged || !shortcutsChanged) window.dispatchEvent(new Event(PANEL_CONTEXT_CHANGED));
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}
