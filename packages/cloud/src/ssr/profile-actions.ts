import { type DropdownItem, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { importOnDemand } from "../browser/reload";
import type { CloudThemePreference } from "../shared/theme";
import { createPreferenceController } from "./preference-controller";

/** `appHref` is set while the installation offers the mobile app; the item then leads to `/me/app`. */
export function createProfileActions(initialTheme: CloudThemePreference, appHref?: string, userId?: string) {
  const locale = useLocale();
  const preferences = createPreferenceController(initialTheme, locale);
  const [signingOut, setSigningOut] = createSignal(false);
  const signOut = async () => {
    if (signingOut()) return;
    setSigningOut(true);
    // The API client and the push client load with the first sign-out, not with every page.
    const loaded = await importOnDemand(() => import("../browser/session"));
    if (!loaded) {
      setSigningOut(false);
      return;
    }
    try {
      await loaded.signOutBrowserSession(userId, preferences.messages().signOutFailed);
      window.location.href = "/auth/login";
    } catch {
      toast.error(preferences.messages().signOutFailed);
      setSigningOut(false);
    }
  };

  const items = createMemo<DropdownItem[]>(() => [
    preferences.appearanceItem,
    preferences.languageItem(),
    {
      href: "/me",
      icon: "ti ti-user-circle",
      label: preferences.messages().profileSettings,
    },
    ...(appHref ? [{ href: appHref, icon: "ti ti-device-mobile", label: preferences.messages().app }] : []),
    {
      action: signOut,
      icon: "ti ti-logout",
      label: preferences.messages().signOut,
      disabled: signingOut(),
    },
  ]);

  return { preferences, items, signOut, signingOut };
}
