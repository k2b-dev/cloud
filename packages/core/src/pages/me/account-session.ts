import { browserNotificationClient } from "@k2b/cloud/browser/notifications";
import { apiClient } from "@k2b/cloud/clients/core";
import { normalizeRedirectTo } from "@k2b/cloud/shared";

export const signOutCurrentSession = async (errorMessage = "Sign out failed. Please try again.", returnTo?: string): Promise<void> => {
  await browserNotificationClient.disable().catch(() => undefined);
  const response = await apiClient.auth.logout.$post();
  if (!response.ok) throw new Error(errorMessage);
  const redirectTo = normalizeRedirectTo(returnTo);
  window.location.href = redirectTo ? `/auth/login?${new URLSearchParams({ redirectTo })}` : "/auth/login";
};
