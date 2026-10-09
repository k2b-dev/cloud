/** Window event the Cloud layout listens to; dispatched by `refreshAppBadges()`. */
export const APP_BADGES_REFRESH_EVENT = "cloud:app-badges-refresh";

/**
 * Reads every app's `nav.badge` route again now, instead of at the next
 * scheduled read. Call it after the person changed what your badge counts,
 * for example after reading a conversation, so the rail and the app grid
 * agree with the page. Calls while a read is still running wait for it and
 * then share one more read, so calling it often never stacks up requests.
 * Does nothing outside the Cloud layout, in a hidden tab, or when no running
 * app declares a badge.
 */
export const refreshAppBadges = (): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(APP_BADGES_REFRESH_EVENT));
};
