/**
 * Records `data-k2b-input="touch" | "trackpad"` and the sticky
 * `data-k2b-kbd="on"` on `<html>` of root after qualifying input events.
 * Returns a function that removes listeners but keeps the attributes.
 * No-op on the server; installing does not change the initial HTML.
 */
export const installInputModeController = (
  root: Document | undefined = typeof document === "undefined" ? undefined : document,
): (() => void) => {
  if (!root) return () => {};
  const html = root.documentElement;
  const pointer = (event: PointerEvent) => {
    const mode = event.pointerType === "mouse" ? "trackpad" : event.pointerType === "touch" || event.pointerType === "pen" ? "touch" : null;
    if (mode && html.getAttribute("data-k2b-input") !== mode) html.setAttribute("data-k2b-input", mode);
  };
  const keydown = (event: KeyboardEvent) => {
    if (
      html.getAttribute("data-k2b-kbd") === "on" ||
      event.isComposing ||
      !event.key ||
      /^(?:Shift|Control|Alt|AltGraph|Meta|OS|Super|Hyper|Fn|FnLock|CapsLock|NumLock|ScrollLock|Symbol|SymbolLock|Unidentified|Process|Dead)$/.test(
        event.key,
      )
    )
      return;

    const target = event.composedPath()[0] ?? event.target;
    // Use the document's realm: a host can install on another document.
    const HTMLElement = root.defaultView?.HTMLElement;
    const element = HTMLElement && target instanceof HTMLElement ? target : null;
    const textField =
      element &&
      (element.localName === "textarea" ||
        element.isContentEditable ||
        (element.localName === "input" &&
          !/^(?:button|checkbox|radio|range|reset|submit|color|file|image|hidden)$/.test(
            element.getAttribute("type")?.toLowerCase() ?? "text",
          )));
    const shortcut = (event.ctrlKey || event.metaKey) && !event.getModifierState?.("AltGraph");
    if (textField && event.key !== "Tab" && !shortcut) return;
    html.setAttribute("data-k2b-kbd", "on");
  };
  root.addEventListener("pointerdown", pointer, { capture: true, passive: true });
  root.addEventListener("pointermove", pointer, { capture: true, passive: true });
  root.addEventListener("keydown", keydown, true);
  return () => {
    root.removeEventListener("pointerdown", pointer, true);
    root.removeEventListener("pointermove", pointer, true);
    root.removeEventListener("keydown", keydown, true);
  };
};
