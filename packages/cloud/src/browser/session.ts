import { apiClient } from "../clients/core";
import { IDLE_SIGN_OUT_STORAGE_KEY } from "./idle-sign-out";

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

/**
 * On the sign-in page after a shared workstation signed out for lack of input: revokes the session the page left, once
 * the apps saved their work on `pagehide`, and clears that account's data in this browser. The server ends the idle
 * session moments later on its own, so a failure needs no retry.
 */
export const finishIdleSignOut = async (): Promise<void> => {
  let userId: string | null;
  try {
    userId = window.sessionStorage.getItem(IDLE_SIGN_OUT_STORAGE_KEY);
    window.sessionStorage.removeItem(IDLE_SIGN_OUT_STORAGE_KEY);
  } catch {
    return;
  }
  if (userId) await signOutBrowserSession(userId, "Idle sign-out").catch(() => undefined);
};
