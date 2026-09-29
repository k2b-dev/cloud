import { Button, Dropdown, useLocale } from "@k2b/ui";
import { type ProfilePreferenceLocale, profilePreferenceLocale, setLocalePreference } from "../browser/locale-preference";
import { canonicalLocale } from "../shared/locale";
import type { CloudTheme } from "../shared/theme";
import { createPreferenceController } from "./preference-controller";

/**
 * Labeled language and theme controls for the MinimalLayout footer. The
 * language trigger names the current language; the theme button names the
 * mode it switches to, like every other Cloud preference menu.
 */
export default function MinimalLayoutPreferences(props: { initialTheme: CloudTheme }) {
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
          {languageName()}
          <i class="ti ti-chevron-down" aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
      <Button onClick={preferences.toggleTheme} size="sm" variant="ghost">
        <i class={preferences.theme() === "light" ? "ti ti-moon" : "ti ti-sun-high"} aria-hidden="true" />
        {preferences.themeLabel()}
      </Button>
    </div>
  );
}
