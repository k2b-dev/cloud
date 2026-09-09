import { Avatar, Dropdown, type DropdownItem, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { browserNotificationClient } from "../browser/notifications";
import { apiClient } from "../clients/core";
import type { CloudTheme } from "../shared/theme";
import { createPreferenceController } from "./preference-controller";

type ProfilePreferencesProps = {
  avatarSrc?: string;
  initialTheme: CloudTheme;
  name: string;
  placement: "header" | "rail";
};

export default function ProfilePreferences(props: ProfilePreferencesProps) {
  const locale = useLocale();
  const preferences = createPreferenceController(props.initialTheme, locale);
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

  const avatar = () => <Avatar name={props.name} src={props.avatarSrc} size="xs" />;

  return (
    <div class="layout-profile-preferences" data-placement={props.placement}>
      <button type="button" class="layout-profile-preferences__link" aria-label={preferences.messages().menuLabel}>
        {avatar()}
      </button>
      <div class="layout-profile-preferences__panel dropdown-menu-surface">
        <button type="button" class="menu-item" onClick={preferences.toggleTheme}>
          <i class={`ti ${preferences.theme() === "light" ? "ti-moon" : "ti-sun-high"}`} aria-hidden="true" />
          <span>{preferences.themeLabel()}</span>
        </button>
        <button type="button" class="menu-item" onClick={preferences.toggleLanguage}>
          <i class="ti ti-language" aria-hidden="true" />
          <span>{preferences.languageLabel()}</span>
        </button>
        <a href="/me" class="menu-item">
          <i class="ti ti-user-circle" aria-hidden="true" />
          <span>{preferences.messages().profileSettings}</span>
        </a>
        <button type="button" class="menu-item" onClick={signOut} disabled={signingOut()}>
          <i class="ti ti-logout" aria-hidden="true" />
          <span>{preferences.messages().signOut}</span>
        </button>
      </div>
      <Dropdown.Root
        class="layout-profile-preferences__dropdown"
        items={items()}
        label={preferences.messages().menuLabel}
        position={props.placement === "rail" ? "right-start" : "bottom-left"}
        width="14rem"
      >
        <Dropdown.Trigger
          appearance="plain"
          class="layout-profile-preferences__dropdown-trigger"
          iconOnly
          label={preferences.messages().menuLabel}
          tooltip={false}
        >
          {avatar()}
        </Dropdown.Trigger>
      </Dropdown.Root>
    </div>
  );
}
