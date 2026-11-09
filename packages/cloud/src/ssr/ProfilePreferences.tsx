import { Avatar, Dropdown, type DropdownItem, Kbd, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { readShellFocus, SHELL_FOCUS_CHANGE_EVENT, toggleShellFocus } from "../browser/shell-focus";
import type { CloudThemePreference } from "../shared/theme";
import { platformMessages } from "./platform-messages";
import { createProfileActions } from "./profile-actions";
import { useShellData } from "./shell-data";

type ProfilePreferencesProps = {
  userId?: string;
  /** Set while the installation offers the mobile app. */
  appHref?: string;
  avatarSrc?: string;
  initialTheme: CloudThemePreference;
  name: string;
};

/**
 * The avatar at the bottom of the rail. Its menu opens beside the rail and,
 * because the avatar is the rail's last control, grows upward from the window's
 * bottom edge. While the sidebar is hidden, CSS keeps only the avatar and sets
 * it at the bottom start corner of the window; its menu then shows the sidebar
 * again. The menu's first entry hides or shows the sidebar: both entries are
 * server markup, and the canvas's `data-shell-focus` decides in CSS which one
 * shows, so the first frame is final. `ShellRuntime` handles their clicks by
 * `data-cloud-shell-focus-toggle`.
 */
export default function ProfilePreferences(props: ProfilePreferencesProps) {
  const locale = useLocale();
  const data = useShellData();
  const t = () => platformMessages.resolve([locale()]).t;
  const { preferences, items, signOut, signingOut } = createProfileActions(props.initialTheme, props.appHref, props.userId);
  const [sidebarHidden, setSidebarHidden] = createSignal(false);
  onMount(() => {
    const sync = () => setSidebarHidden(readShellFocus());
    sync();
    window.addEventListener(SHELL_FOCUS_CHANGE_EVENT, sync);
    onCleanup(() => window.removeEventListener(SHELL_FOCUS_CHANGE_EVENT, sync));
  });
  const shortcut = () => <Kbd keys={"mod+\\"} platform={data?.platform} />;
  const menuItems = createMemo<DropdownItem[]>(() => [
    {
      items: [
        {
          icon: sidebarHidden() ? "ti ti-layout-sidebar-left-expand" : "ti ti-layout-sidebar-left-collapse",
          label: sidebarHidden() ? t().showSidebar : t().hideSidebar,
          trailing: shortcut(),
          action: toggleShellFocus,
        },
      ],
    },
    ...items(),
  ]);

  // The person's name shows beside the avatar on wide windows, so it is also part of the spoken name.
  const avatar = () => [<Avatar name={props.name} src={props.avatarSrc} size="sm" />, <span class="rail-item-label">{props.name}</span>];
  const menuLabel = () => `${props.name}, ${preferences.messages().menuLabel}`;

  return (
    <div class="layout-profile-preferences">
      <button type="button" class="layout-profile-preferences__link" aria-label={menuLabel()} data-cloud-shell-focus-return="">
        {avatar()}
      </button>
      <div class="layout-profile-preferences__panel dropdown-menu-surface">
        <div class="layout-profile-preferences__section">
          <button type="button" class="menu-item" data-cloud-shell-focus-toggle="hide">
            <i class="ti ti-layout-sidebar-left-collapse" aria-hidden="true" />
            <span>{t().hideSidebar}</span>
            {shortcut()}
          </button>
          <button type="button" class="menu-item" data-cloud-shell-focus-toggle="show">
            <i class="ti ti-layout-sidebar-left-expand" aria-hidden="true" />
            <span>{t().showSidebar}</span>
            {shortcut()}
          </button>
        </div>
        <div class="layout-profile-preferences__section">
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
        </div>
        <div class="layout-profile-preferences__section">
          <button type="button" class="menu-item" data-danger="true" onClick={signOut} disabled={signingOut()}>
            <i class="ti ti-logout" aria-hidden="true" />
            <span>{preferences.messages().signOut}</span>
          </button>
        </div>
      </div>
      <Dropdown.Root
        class="layout-profile-preferences__dropdown"
        menuClass="layout-profile-preferences__menu"
        items={menuItems()}
        label={preferences.messages().menuLabel}
        position="right-start"
        width="17rem"
      >
        <Dropdown.Trigger
          appearance="plain"
          class="layout-profile-preferences__dropdown-trigger"
          iconOnly
          label={menuLabel()}
          tooltip={false}
          data-cloud-shell-focus-return=""
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
