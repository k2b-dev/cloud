/**
 * Opens or leaves a screen of its own in place on a v2 page of the Cloud app (`PwaLayout ui="v2"`), as the layout's
 * `screen` does on the server: below 48rem the tab bar steps aside, such as for one chat with its composer at the
 * bottom edge. `from` is any element of the page; outside the v2 frame nothing happens. The v1 frame has
 * `MobileShell.setScreen` from `@k2b/ui`.
 */
export const setPwaScreen = (from: Element, screen: boolean): void => {
  from.closest(".pwa-v2")?.toggleAttribute("data-screen", screen);
};
