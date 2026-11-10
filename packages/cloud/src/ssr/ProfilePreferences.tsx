import { Avatar, Dropdown, type DropdownItem, Kbd, SegmentedControl, useLocale } from "@k2b/ui";
import { createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { requestPrivacyScreen } from "../browser/privacy-timer";
import { readShellFocus, SHELL_FOCUS_CHANGE_EVENT, toggleShellFocus } from "../browser/shell-focus";
import { DEFAULT_PRIVACY_TIMER_SECONDS, PRIVACY_TIMER_CHOICES } from "../contracts/screen-preferences";
import type { CloudThemePreference } from "../shared/theme";
import { platformMessages } from "./platform-messages";
import { PRIVACY_SHORTCUT } from "./privacy-screen-constants";
import { privacyTimerLabel } from "./privacy-screen-messages";
import { createPrivacyTimerChoice, parsePrivacyTimer } from "./privacy-timer-choice";
import { createProfileActions } from "./profile-actions";
import { SharedWorkstationCheck } from "./SharedWorkstationCheck";
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
  const { preferences, items, signOut, signingOut, sharedWorkstation } = createProfileActions(
    props.initialTheme,
    props.appHref,
    props.userId,
  );
  const [sidebarHidden, setSidebarHidden] = createSignal(false);
  onMount(() => {
    const sync = () => setSidebarHidden(readShellFocus());
    sync();
    window.addEventListener(SHELL_FOCUS_CHANGE_EVENT, sync);
    onCleanup(() => window.removeEventListener(SHELL_FOCUS_CHANGE_EVENT, sync));
  });
  const shortcut = () => <Kbd keys={"mod+\\"} platform={data?.platform} />;
  // The privacy screen exists only on computers with a mouse or touchpad; the touch menu shows it there too.
  const privacy = createPrivacyTimerChoice(data?.privacyTimerSeconds ?? DEFAULT_PRIVACY_TIMER_SECONDS, locale);
  const [finePointer, setFinePointer] = createSignal(false);
  onMount(() => setFinePointer(window.matchMedia("(any-pointer: fine)").matches));
  const privacyKeys = () => <Kbd keys={PRIVACY_SHORTCUT} platform={data?.platform} />;
  const privacySections = (): DropdownItem[] =>
    finePointer()
      ? [
          {
            sectionLabel: privacy.messages().section,
            items: [
              {
                icon: "ti ti-eye-off",
                label: privacy.messages().now,
                description: privacy.messages().nowDescription,
                trailing: privacyKeys(),
                action: requestPrivacyScreen,
              },
            ],
          },
          {
            sectionLabel: privacy.messages().timer,
            layout: "row",
            items: PRIVACY_TIMER_CHOICES.map((seconds) => ({
              choice: "radio" as const,
              label: privacyTimerLabel(privacy.messages(), seconds),
              checked: () => privacy.value() === seconds,
              closeOnSelect: false,
              action: () => void privacy.choose(seconds),
            })),
          },
        ]
      : [];
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
    ...privacySections(),
    ...items(),
  ]);
  const timerLabelId = `cloud-privacy-timer-${createUniqueId()}`;

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
        <div class="layout-profile-preferences__section" role="group" aria-labelledby={`${timerLabelId}-section`}>
          <span class="layout-profile-preferences__label" id={`${timerLabelId}-section`}>
            <i class="ti ti-user" aria-hidden="true" />
            {privacy.messages().section}
          </span>
          <button
            type="button"
            class="menu-item"
            aria-keyshortcuts={data?.platform === "apple" ? "Meta+Period" : "Control+Period"}
            onClick={(event) => {
              // The open panel would show again around a focused entry once the content is back.
              event.currentTarget.blur();
              requestPrivacyScreen();
            }}
          >
            <i class="ti ti-eye-off" aria-hidden="true" />
            <span class="layout-profile-preferences__copy">
              <span>{privacy.messages().now}</span>
              <small>{privacy.messages().nowDescription}</small>
            </span>
            {privacyKeys()}
          </button>
          <div class="layout-profile-preferences__timer">
            <span class="layout-profile-preferences__caption" id={timerLabelId}>
              {privacy.messages().timer}
            </span>
            <SegmentedControl
              size="sm"
              class="layout-profile-preferences__segments"
              options={privacy.options()}
              value={() => String(privacy.value())}
              ariaLabel={privacy.messages().timer}
              onValueChange={(value) => {
                const seconds = parsePrivacyTimer(value);
                if (seconds !== undefined) void privacy.choose(seconds);
              }}
            />
          </div>
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
        {/* What belongs to this browser, not to the person: the shared workstation mark and sign-out. */}
        <div
          class="layout-profile-preferences__section"
          role="group"
          aria-labelledby={props.userId ? "cloud-profile-browser-section" : undefined}
        >
          {props.userId && (
            <>
              <span class="layout-profile-preferences__label" id="cloud-profile-browser-section">
                <i class="ti ti-browser" aria-hidden="true" />
                {sharedWorkstation.messages().browserSection}
              </span>
              <button
                type="button"
                class="menu-item"
                role="switch"
                aria-checked={sharedWorkstation.shared()}
                aria-describedby="cloud-shared-workstation-description"
                disabled={sharedWorkstation.pending()}
                onClick={() => void sharedWorkstation.toggle()}
              >
                <SharedWorkstationCheck checked={sharedWorkstation.shared()} />
                <span class="layout-profile-preferences__copy">
                  <span>{sharedWorkstation.messages().label}</span>
                  <small id="cloud-shared-workstation-description">{sharedWorkstation.messages().description}</small>
                </span>
              </button>
            </>
          )}
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
        width="20rem"
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
