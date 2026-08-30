import { Avatar, Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
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

  const items = createMemo<DropdownItem[]>(() => [
    ...preferences.items(),
    {
      href: "/me",
      icon: "ti ti-user-circle",
      label: preferences.messages().profileSettings,
    },
  ]);

  const avatar = () => <Avatar name={props.name} src={props.avatarSrc} size="xs" />;

  return (
    <div class="layout-profile-preferences" data-placement={props.placement}>
      <a href="/me" class="layout-profile-preferences__link" aria-label={preferences.messages().profileSettings}>
        {avatar()}
      </a>
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
