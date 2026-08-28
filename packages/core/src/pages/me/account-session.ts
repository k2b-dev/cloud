import { browserNotificationClient } from "@valentinkolb/cloud/browser/notifications";
import { apiClient } from "@valentinkolb/cloud/clients/core";

export const signOutCurrentSession = async (errorMessage = "Sign out failed. Please try again."): Promise<void> => {
  await browserNotificationClient.disable().catch(() => undefined);
  const response = await apiClient.auth.logout.$post();
  if (!response.ok) throw new Error(errorMessage);
  window.location.href = "/auth/login";
};
