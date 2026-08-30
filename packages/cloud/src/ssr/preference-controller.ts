import type { DropdownItem } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { profilePreferenceLocale, setLocalePreference } from "../browser/locale-preference";
import { type CloudTheme, getCurrentThemePreference, setThemePreference } from "../shared/theme";
import { profilePreferencesMessages } from "./profile-preferences-messages";

const THEME_PREFERENCE_EVENT = "cloud:theme-preference";

export const createPreferenceController = (initialTheme: CloudTheme, locale: () => string) => {
  const [theme, setTheme] = createSignal(initialTheme);
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
  ]);

  return { items, languageLabel, messages, theme, themeLabel, toggleLanguage, toggleTheme };
};
