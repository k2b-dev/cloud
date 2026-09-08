import { localStore } from "@k2b/stdlib/solid";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { authMessages } from "./i18n";

export type Language = "system" | "en" | "de";
export type Theme = "system" | "light" | "dark";

export function createPreferences() {
  const [stored, setStored] = localStore.create<{ language: Language; theme: Theme }>("pwa-auth.preferences", {
    language: "system",
    theme: "system",
  });
  const language = () => (stored.language === "en" || stored.language === "de" ? stored.language : "system");
  const theme = () => (stored.theme === "light" || stored.theme === "dark" ? stored.theme : "system");
  const media = matchMedia("(prefers-color-scheme: dark)");
  const [dark, setDark] = createSignal(media.matches);
  const [languages, setLanguages] = createSignal(navigator.languages);
  const updateTheme = () => setDark(media.matches);
  const updateLanguage = () => setLanguages(navigator.languages);
  media.addEventListener("change", updateTheme);
  window.addEventListener("languagechange", updateLanguage);
  onCleanup(() => {
    media.removeEventListener("change", updateTheme);
    window.removeEventListener("languagechange", updateLanguage);
  });
  const locale = createMemo(() => authMessages.resolve(language() === "system" ? languages() : [language()]).locale);
  createEffect(() => {
    document.documentElement.lang = locale();
  });
  createEffect(() => {
    document.body.dataset.theme = theme() === "system" ? (dark() ? "dark" : "light") : theme();
    const color = getComputedStyle(document.body).backgroundColor;
    document.documentElement.style.backgroundColor = color;
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.removeAttribute("media");
      meta.content = color;
    }
  });
  return {
    locale,
    language,
    theme,
    setLanguage: (value: Language) => setStored("language", value),
    setTheme: (value: Theme) => setStored("theme", value),
  };
}

export type Preferences = ReturnType<typeof createPreferences>;
