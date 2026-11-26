/** The mark of a screen of its own on the v1 frame, as `MobileShell.setScreen` from `@k2b/ui` sets it. */
const V1_SCREEN = "data-k2b-screen";

/**
 * Opens or leaves a screen of its own in place on a page of the Cloud app built with `PwaLayout ui="v2"`, as the
 * layout's `screen` does on the server: below 48rem the tab bar steps aside, such as for one chat with its composer at
 * the bottom edge. `from` is any element of the page. Beside an older Core such a page shows in the v1 frame; there it
 * marks the `MobileShell` as `MobileShell.setScreen` does, without loading it. Outside both frames nothing happens.
 */
export const setPwaScreen = (from: Element, screen: boolean): void => {
  const v2 = from.closest(".pwa-v2");
  if (v2) v2.toggleAttribute("data-screen", screen);
  else from.closest(".k2b-mobile-shell")?.toggleAttribute(V1_SCREEN, screen);
};
