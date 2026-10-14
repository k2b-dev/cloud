import type { DropdownAction, DropdownItem } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { profilePreferenceLocale, setLocalePreference } from "../shared/locale-preference";
import { type CloudThemePreference, getCurrentThemePreference, setThemePreference } from "../shared/theme";
import { profilePreferencesMessages } from "./profile-preferences-messages";

const THEME_PREFERENCE_EVENT = "cloud:theme-preference";
export const THEME_CYCLE = ["system", "light", "dark"] as const satisfies readonly CloudThemePreference[];
const THEME_ICONS: Record<CloudThemePreference, string> = { light: "ti ti-sun-high", dark: "ti ti-moon", system: "ti ti-device-laptop" };

export const nextThemePreference = (current: CloudThemePreference): CloudThemePreference =>
  THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length]!;

export const createPreferenceController = (initialTheme: CloudThemePreference, locale: () => string) => {
  const [theme, updateTheme] = createSignal(initialTheme);
  const [announcedTheme, setAnnouncedTheme] = createSignal<CloudThemePreference>();
  const messages = () => profilePreferencesMessages.resolve([locale()]).t;
  const language = () => profilePreferenceLocale(locale());
  const nextLanguage = () => (language() === "de" ? "en" : "de");
  const languageLabel = () => (nextLanguage() === "de" ? messages().switchToGerman : messages().switchToEnglish);

  const setTheme = (mode: CloudThemePreference) => {
    updateTheme(setThemePreference(mode));
    window.dispatchEvent(new Event(THEME_PREFERENCE_EVENT));
  };
  const toggleLanguage = () => setLocalePreference(nextLanguage());

  onMount(() => {
    const syncTheme = () => updateTheme(getCurrentThemePreference());
    syncTheme();
    window.addEventListener(THEME_PREFERENCE_EVENT, syncTheme);
    onCleanup(() => window.removeEventListener(THEME_PREFERENCE_EVENT, syncTheme));
  });

  const themeOption = (value: CloudThemePreference) => ({
    value,
    icon: THEME_ICONS[value],
    label: { light: messages().themeLight, dark: messages().themeDark, system: messages().themeSystem }[value],
  });
  const cycleTheme = () => {
    const next = nextThemePreference(theme());
    setTheme(next);
    setAnnouncedTheme(next);
  };
  const themeCycleLabel = () =>
    messages().themeCycle({
      current: themeOption(theme()).label,
      next: themeOption(nextThemePreference(theme())).label,
    });
  const themeAnnouncement = () => {
    const current = announcedTheme();
    return current === undefined ? "" : messages().themeChanged({ current: themeOption(current).label });
  };
  const appearanceItem: DropdownAction = {
    get icon() {
      return themeOption(theme()).icon;
    },
    get label() {
      return themeOption(theme()).label;
    },
    get ariaLabel() {
      return themeCycleLabel();
    },
    closeOnSelect: false,
    action: cycleTheme,
  };
  const languageItem = (): DropdownAction => ({ action: toggleLanguage, icon: "ti ti-language", label: languageLabel() });
  const items = createMemo<DropdownItem[]>(() => [appearanceItem, languageItem()]);

  return {
    items,
    appearanceItem,
    languageItem,
    themeOption,
    language,
    languageLabel,
    messages,
    theme,
    cycleTheme,
    themeCycleLabel,
    themeAnnouncement,
    toggleLanguage,
  };
};
