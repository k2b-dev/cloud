import { isPrivacyTimerSeconds, type PrivacyTimerSeconds } from "../contracts/privacy-timer";

/** Every Cloud tab of this browser hears timer changes and the privacy screen's state on this channel. */
export const PRIVACY_CHANNEL = "cloud.privacy";
/** Window event with the saved timer, so the menu, the app bar slot and the settings page follow one change. */
export const PRIVACY_TIMER_EVENT = "cloud.privacy.timer";
/** Window event that asks the privacy screen to cover (`on`) or show (`off`) the content. */
export const PRIVACY_REQUEST_EVENT = "cloud.privacy.request";

export type PrivacyRequest = { action: "on" | "off" };
export type PrivacyChannelMessage =
  | { type: "hello" }
  | { type: "timer"; seconds: PrivacyTimerSeconds }
  | { type: "on" }
  | { type: "off" }
  | { type: "activity" };

/** Asks this tab's privacy screen to cover the content now; it reaches the other tabs from there. */
export const requestPrivacyScreen = (): void => {
  window.dispatchEvent(new CustomEvent<PrivacyRequest>(PRIVACY_REQUEST_EVENT, { detail: { action: "on" } }));
};

/** Tells this tab's listeners about a saved timer. */
export const publishPrivacyTimer = (seconds: PrivacyTimerSeconds) =>
  window.dispatchEvent(new CustomEvent<PrivacyTimerSeconds>(PRIVACY_TIMER_EVENT, { detail: seconds }));

export const onPrivacyTimer = (listener: (seconds: PrivacyTimerSeconds) => void): (() => void) => {
  const handle = (event: Event) => {
    const seconds = (event as CustomEvent<unknown>).detail;
    if (isPrivacyTimerSeconds(seconds)) listener(seconds);
  };
  window.addEventListener(PRIVACY_TIMER_EVENT, handle);
  return () => window.removeEventListener(PRIVACY_TIMER_EVENT, handle);
};

const openChannel = () => (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(PRIVACY_CHANNEL));

/** Saves the person's timer. Resolves `false` when the server did not save it. */
export const savePrivacyTimer = async (seconds: PrivacyTimerSeconds): Promise<boolean> => {
  try {
    // The API client loads with the first change, not with every page.
    const { coreClient } = await import("../clients/core");
    const response = await coreClient.me.screen.$put({ json: { privacyTimerSeconds: seconds } });
    return response.ok;
  } catch {
    return false;
  }
};

/** Tells this tab and the other tabs of this browser about a saved timer. */
export const announceSavedPrivacyTimer = (seconds: PrivacyTimerSeconds) => {
  publishPrivacyTimer(seconds);
  const channel = openChannel();
  channel?.postMessage({ type: "timer", seconds } satisfies PrivacyChannelMessage);
  channel?.close();
};
