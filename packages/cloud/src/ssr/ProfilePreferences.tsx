import { Avatar, Dropdown } from "@k2b/ui";
import type { CloudThemePreference } from "../shared/theme";
import { createProfileActions } from "./profile-actions";

type ProfilePreferencesProps = {
  /** Set while the installation offers the mobile app. */
  appHref?: string;
  avatarSrc?: string;
  initialTheme: CloudThemePreference;
  name: string;
};

/**
 * The avatar at the bottom of the rail. Its menu opens beside the rail and,
 * because the avatar is the rail's last control, grows upward from the window's
 * bottom edge.
 */
export default function ProfilePreferences(props: ProfilePreferencesProps) {
  const { preferences, items, signOut, signingOut } = createProfileActions(props.initialTheme, props.appHref);

  const avatar = () => <Avatar name={props.name} src={props.avatarSrc} size="xs" />;

  return (
    <div class="layout-profile-preferences">
      <button type="button" class="layout-profile-preferences__link" aria-label={preferences.messages().menuLabel}>
        {avatar()}
      </button>
      <div class="layout-profile-preferences__panel dropdown-menu-surface">
        <button type="button" class="menu-item" aria-label={preferences.themeCycleLabel()} onClick={preferences.cycleTheme}>
          <i class={preferences.themeOption(preferences.theme()).icon} aria-hidden="true" />
          <span>{preferences.themeOption(preferences.theme()).label}</span>
        </button>
        <button type="button" class="menu-item" onClick={preferences.toggleLanguage}>
          <i class="ti ti-language" aria-hidden="true" />
          <span>{preferences.languageLabel()}</span>
        </button>
        <a href="/me" class="menu-item">
          <i class="ti ti-user-circle" aria-hidden="true" />
          <span>{preferences.messages().profileSettings}</span>
        </a>
        {props.appHref && (
          <a href={props.appHref} class="menu-item">
            <i class="ti ti-device-mobile" aria-hidden="true" />
            <span>{preferences.messages().app}</span>
          </a>
        )}
        <button type="button" class="menu-item" onClick={signOut} disabled={signingOut()}>
          <i class="ti ti-logout" aria-hidden="true" />
          <span>{preferences.messages().signOut}</span>
        </button>
      </div>
      <Dropdown.Root
        class="layout-profile-preferences__dropdown"
        items={items()}
        label={preferences.messages().menuLabel}
        position="right-start"
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
      <span class="sr-only" aria-live="polite">
        {preferences.themeAnnouncement()}
      </span>
    </div>
  );
}
