import type { NotificationQuietState } from "@k2b/cloud/contracts";

/**
 * The line above the chats about this device. Only the browser knows it, so the device remembers the last one in a
 * cookie and the server draws it in the first picture; the list moves only when the state really changed.
 */
export type DeviceNotice =
  | { kind: "ask" }
  | { kind: "home-screen" }
  | { kind: "quiet"; reason: NonNullable<NotificationQuietState["reason"]>; until: string | null }
  | { kind: "none" };

/** Chat in the browser (`/app/chat`) and in the Cloud app (`/pwa/chat`) share the device's line. */
export const CHAT_DEVICE_NOTICE_COOKIE = "chat_device_notice";
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const serializeDeviceNotice = (notice: DeviceNotice): string =>
  notice.kind === "quiet" ? `${notice.reason}.${notice.until ?? ""}` : notice.kind;

/** The remembered notice, or none for anything unknown or a quiet time that has ended by `now`. */
export const parseDeviceNotice = (value: string | undefined, now: Date): DeviceNotice => {
  if (value === "ask" || value === "home-screen") return { kind: value };
  const quiet = /^(doNotDisturb|quietHours)\.(.*)$/.exec(value ?? "");
  if (!quiet) return { kind: "none" };
  const until = quiet[2] ? quiet[2] : null;
  if (until !== null && !(Date.parse(until) > now.getTime())) return { kind: "none" };
  return { kind: "quiet", reason: quiet[1] === "doNotDisturb" ? "doNotDisturb" : "quietHours", until };
};

export const deviceNoticeCookie = (notice: DeviceNotice): string =>
  `${CHAT_DEVICE_NOTICE_COOKIE}=${encodeURIComponent(serializeDeviceNotice(notice))}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
