const focused = new WeakMap<Element, string>();
/** Module evaluation precedes SSR's destructive island mount. */
export function capturePanelFocus() {
  if (typeof document === "undefined") return;
  const element = document.activeElement;
  const wrapper = element?.closest("solid-island");
  if (!wrapper || !(element instanceof HTMLElement)) return;
  const topic = element.dataset.helpTopic;
  const selector =
    topic !== undefined
      ? `[data-help-topic="${CSS.escape(topic)}"]`
      : element.matches("[data-help-menu]")
        ? "[data-help-menu]"
        : element.matches(".help-head-back")
          ? ".help-head-back"
          : undefined;
  if (selector) focused.set(wrapper, selector);
}
export function restorePanelFocus(element: Element) {
  const wrapper = element.closest("solid-island");
  const selector = wrapper && focused.get(wrapper);
  if (!wrapper || !selector) return;
  focused.delete(wrapper);
  wrapper.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
}

/** One provider reader per document; production island wrappers intentionally omit data-file. */
export function panelElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.help-shell[data-surface="panel"]');
  if (!element) throw new Error("Missing Help panel");
  return element;
}
