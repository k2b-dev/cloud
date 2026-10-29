import { signOutBrowserSession } from "@k2b/cloud/browser/session";
import { normalizeRedirectTo } from "@k2b/cloud/shared";

export const signOutCurrentSession = async (
  userId: string,
  errorMessage = "Sign out failed. Please try again.",
  returnTo?: string,
): Promise<void> => {
  await signOutBrowserSession(userId, errorMessage);
  const redirectTo = normalizeRedirectTo(returnTo);
  window.location.href = redirectTo ? `/auth/login?${new URLSearchParams({ redirectTo })}` : "/auth/login";
};
