import { isPanelContextMessage } from "../contracts/panel-context-plain";
import { PANEL_CONTEXT_CHANGED, PANEL_CONTEXT_ELEMENT, readProviderContext } from "./panel-context-bridge";

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
    element.textContent = JSON.stringify(context);
    window.dispatchEvent(new Event(PANEL_CONTEXT_CHANGED));
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}
