import { apiClient } from "../clients/core";
import { IDLE_SIGN_OUT_STORAGE_KEY, type IdleSignOutRecord } from "./idle-sign-out";

/** Fence and remove application-owned entries in the authenticated user's browser namespace. */
const clearUserStorage = (userId: string): void => {
  const prefix = `cloud:user:${userId}:`;
  localStorage.setItem(`cloud:user-epoch:${userId}`, crypto.randomUUID());
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("cloud:user-storage-invalidated", { detail: { userId } }));
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
  for (const key of keys) if (key?.startsWith(prefix)) localStorage.removeItem(key);
};

/** Revoke this browser's credential even if local storage cleanup fails. The caller keeps a visible retry until both succeed. */
export const signOutBrowserSession = async (userId: string | undefined, errorMessage: string): Promise<void> => {
  await import("./notifications").then(({ browserNotificationClient }) => browserNotificationClient.disable()).catch(() => undefined);
  let cleanupFailed = false;
  try {
    if (userId) {
      clearUserStorage(userId);
      const { logoutSharedTextOffline } = await import("./shared-text-offline");
      await logoutSharedTextOffline(userId);
    }
  } catch {
    cleanupFailed = true;
  }
  const response = await apiClient.auth.logout.$post({}, { headers: { "x-cloud-logout-user": userId ?? "none" } });
  // Close the interval between the first local fence and credential revocation:
  // a tab that authenticated during it must not retain or recreate device data.
  if (response.ok && userId) {
    try {
      clearUserStorage(userId);
      const { logoutSharedTextOffline } = await import("./shared-text-offline");
      await logoutSharedTextOffline(userId);
      cleanupFailed = false;
    } catch {
      cleanupFailed = true;
    }
  }
  if (!response.ok || cleanupFailed) throw new Error(errorMessage);
};

const readIdleSignOut = (): IdleSignOutRecord | null => {
  try {
    const raw = window.sessionStorage.getItem(IDLE_SIGN_OUT_STORAGE_KEY);
    const record: unknown = raw ? JSON.parse(raw) : null;
    if (!record || typeof record !== "object" || !("userId" in record) || !("sid" in record)) return null;
    const { userId, sid } = record;
    return typeof userId === "string" && typeof sid === "string" ? { userId, sid } : null;
  } catch {
    return null;
  }
};

/**
 * On the sign-in page after a shared workstation signed out for lack of input: revokes exactly the session the tab
 * left, once the apps saved their work on `pagehide`, and clears that account's data in this browser. A newer sign-in
 * of the same account keeps its session and data. The record stays until every step succeeded, so `"failed"` can be
 * retried; `"none"` means there was nothing to finish.
 */
export const finishIdleSignOut = async (): Promise<"done" | "failed" | "none"> => {
  const record = readIdleSignOut();
  if (!record) return "none";
  const response = await apiClient.auth.logout
    .$post({}, { headers: { "x-cloud-logout-user": record.userId, "x-cloud-logout-session": record.sid } })
    .catch(() => null);
  if (!response) return "failed";
  let failed = !response.ok && response.status !== 409;
  if (response.ok) {
    // Each step runs on its own: a failed push unsubscribe must not keep local drafts.
    const steps = [
      () => import("./notifications").then(({ browserNotificationClient }) => browserNotificationClient.disable()),
      async () => clearUserStorage(record.userId),
      () => import("./shared-text-offline").then(({ logoutSharedTextOffline }) => logoutSharedTextOffline(record.userId)),
    ];
    for (const step of steps) await step().catch(() => (failed = true));
  }
  if (!failed) {
    try {
      window.sessionStorage.removeItem(IDLE_SIGN_OUT_STORAGE_KEY);
    } catch {
      // Nothing is left to finish; a later visit repeats an idempotent sign-out at worst.
    }
  }
  return failed ? "failed" : "done";
};
