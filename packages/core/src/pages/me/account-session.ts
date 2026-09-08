import { browserNotificationClient } from "@valentinkolb/cloud/browser/notifications";
import { apiClient } from "@valentinkolb/cloud/clients/core";
import { normalizeRedirectTo } from "@valentinkolb/cloud/shared";

export const signOutCurrentSession = async (errorMessage = "Sign out failed. Please try again.", returnTo?: string): Promise<void> => {
  await browserNotificationClient.disable().catch(() => undefined);
  const response = await apiClient.auth.logout.$post();
  if (!response.ok) throw new Error(errorMessage);
  const redirectTo = normalizeRedirectTo(returnTo);
  window.location.href = redirectTo ? `/auth/login?${new URLSearchParams({ redirectTo })}` : "/auth/login";
};
