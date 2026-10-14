import { Dropdown, useLocale } from "@k2b/ui";
import { canonicalLocale } from "../shared/locale";
import { type ProfilePreferenceLocale, profilePreferenceLocale, setLocalePreference } from "../shared/locale-preference";
import type { CloudThemePreference } from "../shared/theme";
import { createPreferenceController } from "./preference-controller";
import { ThemeCycleButton } from "./ThemeCycleButton";

/** Language opens a menu; appearance cycles in place and keeps its accessible name below md. */
export default function MinimalLayoutPreferences(props: { initialTheme: CloudThemePreference }) {
  const locale = useLocale();
  const preferences = createPreferenceController(props.initialTheme, locale);
  const t = preferences.messages;
  const language = () => profilePreferenceLocale(locale());
  const languageName = () => (language() === "de" ? t().switchToGerman : t().switchToEnglish);
  // Keep a regional locale such as en-GB when its language is chosen again,
  // but let a visitor on an unsupported locale such as fr-FR, who reads the
  // English fallback, still choose English explicitly.
  const choose = (next: ProfilePreferenceLocale) => {
    if (canonicalLocale(locale())?.split("-")[0] !== next) setLocalePreference(next);
  };

  return (
    <div class="minimal-layout-footer__preferences">
      <Dropdown.Root
        label={t().language}
        position="top-right"
        width="10rem"
        items={[
          { label: t().switchToGerman, choice: "radio", checked: () => language() === "de", action: () => choose("de") },
          { label: t().switchToEnglish, choice: "radio", checked: () => language() === "en", action: () => choose("en") },
        ]}
      >
        <Dropdown.Trigger label={`${t().language}: ${languageName()}`} size="sm" tooltip={false} variant="ghost">
          <i class="ti ti-language" aria-hidden="true" />
          <span class="hidden md:inline">{languageName()}</span>
          <span class="md:hidden">{language().toUpperCase()}</span>
          <i class="ti ti-chevron-down hidden md:inline" aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
      <ThemeCycleButton preferences={preferences} size="sm" variant="ghost" compact />
    </div>
  );
}
