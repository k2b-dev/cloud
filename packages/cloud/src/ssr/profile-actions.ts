import { type DropdownItem, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { browserNotificationClient } from "../browser/notifications";
import { apiClient } from "../clients/core";
import type { CloudTheme } from "../shared/theme";
import { createPreferenceController } from "./preference-controller";

export function createProfileActions(initialTheme: CloudTheme) {
  const locale = useLocale();
  const preferences = createPreferenceController(initialTheme, locale);
  const [signingOut, setSigningOut] = createSignal(false);
  const signOut = async () => {
    if (signingOut()) return;
    setSigningOut(true);
    try {
      await browserNotificationClient.disable().catch(() => undefined);
      const response = await apiClient.auth.logout.$post();
      if (!response.ok) throw new Error(preferences.messages().signOutFailed);
      window.location.href = "/auth/login";
    } catch {
      toast.error(preferences.messages().signOutFailed);
      setSigningOut(false);
    }
  };

  const items = createMemo<DropdownItem[]>(() => [
    ...preferences.items(),
    {
      href: "/me",
      icon: "ti ti-user-circle",
      label: preferences.messages().profileSettings,
    },
    {
      action: signOut,
      icon: "ti ti-logout",
      label: preferences.messages().signOut,
      disabled: signingOut(),
    },
  ]);

  return { preferences, items, signOut, signingOut };
}
