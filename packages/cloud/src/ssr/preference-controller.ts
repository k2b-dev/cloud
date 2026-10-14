import type { DropdownAction, DropdownItem, DropdownSection } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { profilePreferenceLocale, setLocalePreference } from "../shared/locale-preference";
import { type CloudThemePreference, getCurrentThemePreference, setThemePreference } from "../shared/theme";
import { profilePreferencesMessages } from "./profile-preferences-messages";

const THEME_PREFERENCE_EVENT = "cloud:theme-preference";
const THEME_PREFERENCES = ["light", "dark", "system"] as const satisfies readonly CloudThemePreference[];
const THEME_ICONS: Record<CloudThemePreference, string> = { light: "ti ti-sun-high", dark: "ti ti-moon", system: "ti ti-sun-moon" };

export const createPreferenceController = (initialTheme: CloudThemePreference, locale: () => string) => {
  const [theme, updateTheme] = createSignal(initialTheme);
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
  const themeOptions = () => THEME_PREFERENCES.map(themeOption);
  const appearance = (): DropdownSection => ({
    sectionLabel: messages().appearance,
    layout: "row",
    items: themeOptions().map(({ value, label, icon }) => ({
      label,
      icon,
      choice: "radio",
      checked: () => theme() === value,
      closeOnSelect: false,
      action: () => setTheme(value),
    })),
  });
  const languageItem = (): DropdownAction => ({ action: toggleLanguage, icon: "ti ti-language", label: languageLabel() });
  const items = createMemo<DropdownItem[]>(() => [appearance(), { items: [languageItem()] }]);

  return { items, appearance, languageItem, themeOption, themeOptions, language, languageLabel, messages, theme, setTheme, toggleLanguage };
};
