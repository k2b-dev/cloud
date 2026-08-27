import { Avatar, Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { profilePreferenceLocale, setLocalePreference } from "../browser/locale-preference";
import { type CloudTheme, getCurrentThemePreference, setThemePreference } from "../shared/theme";
import { profilePreferencesMessages } from "./profile-preferences-messages";

const THEME_PREFERENCE_EVENT = "cloud:theme-preference";

type ProfilePreferencesProps = {
  avatarSrc?: string;
  initialTheme: CloudTheme;
  name: string;
  placement: "header" | "rail";
};

export default function ProfilePreferences(props: ProfilePreferencesProps) {
  const locale = useLocale();
  const [theme, setTheme] = createSignal(props.initialTheme);
  const messages = () => profilePreferencesMessages.resolve([locale()]).t;
  const language = () => profilePreferenceLocale(locale());
  const nextLanguage = () => (language() === "de" ? "en" : "de");
  const themeLabel = () => (theme() === "light" ? messages().switchToDark : messages().switchToLight);
  const languageLabel = () => (nextLanguage() === "de" ? messages().switchToGerman : messages().switchToEnglish);

  const toggleTheme = () => {
    setTheme(setThemePreference(theme() === "dark" ? "light" : "dark"));
    window.dispatchEvent(new Event(THEME_PREFERENCE_EVENT));
  };
  const toggleLanguage = () => setLocalePreference(nextLanguage());

  onMount(() => {
    const syncTheme = () => setTheme(getCurrentThemePreference());
    syncTheme();
    window.addEventListener(THEME_PREFERENCE_EVENT, syncTheme);
    onCleanup(() => window.removeEventListener(THEME_PREFERENCE_EVENT, syncTheme));
  });

  const items = createMemo<DropdownItem[]>(() => [
    {
      action: toggleTheme,
      icon: theme() === "light" ? "ti ti-moon" : "ti ti-sun-high",
      label: themeLabel(),
    },
    {
      action: toggleLanguage,
      icon: "ti ti-language",
      label: languageLabel(),
    },
    {
      href: "/me",
      icon: "ti ti-user-circle",
      label: messages().profileSettings,
    },
  ]);

  const avatar = () => <Avatar name={props.name} src={props.avatarSrc} size="xs" />;

  return (
    <div class="layout-profile-preferences" data-placement={props.placement}>
      <a href="/me" class="layout-profile-preferences__link" aria-label={messages().profileSettings}>
        {avatar()}
      </a>
      <div class="layout-profile-preferences__panel dropdown-menu-surface">
        <button type="button" class="menu-item" onClick={toggleTheme}>
          <i class={`ti ${theme() === "light" ? "ti-moon" : "ti-sun-high"}`} aria-hidden="true" />
          <span>{themeLabel()}</span>
        </button>
        <button type="button" class="menu-item" onClick={toggleLanguage}>
          <i class="ti ti-language" aria-hidden="true" />
          <span>{languageLabel()}</span>
        </button>
        <a href="/me" class="menu-item">
          <i class="ti ti-user-circle" aria-hidden="true" />
          <span>{messages().profileSettings}</span>
        </a>
      </div>
      <Dropdown.Root
        class="layout-profile-preferences__dropdown"
        items={items()}
        label={messages().menuLabel}
        position={props.placement === "rail" ? "right-start" : "bottom-left"}
        width="14rem"
      >
        <Dropdown.Trigger
          appearance="plain"
          class="layout-profile-preferences__dropdown-trigger"
          iconOnly
          label={messages().menuLabel}
          tooltip={false}
        >
          {avatar()}
        </Dropdown.Trigger>
      </Dropdown.Root>
    </div>
  );
}
