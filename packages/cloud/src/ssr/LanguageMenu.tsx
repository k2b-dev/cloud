import { type ButtonSize, Dropdown, type DropdownPosition, useLocale } from "@k2b/ui";
import { canonicalLocale } from "../shared/locale";
import { type ProfilePreferenceLocale, profilePreferenceLocale, setLocalePreference } from "../shared/locale-preference";
import type { createPreferenceController } from "./preference-controller";

type Props = {
  preferences: ReturnType<typeof createPreferenceController>;
  position: DropdownPosition;
  size?: ButtonSize;
};

/**
 * The language as a quiet menu button that names the current choice: "Deutsch ⌄" from `md`, "DE" below. Choosing the
 * other language reloads the page in it.
 */
export function LanguageMenu(props: Props) {
  const locale = useLocale();
  const t = props.preferences.messages;
  const language = () => profilePreferenceLocale(locale());
  const languageName = () => (language() === "de" ? t().switchToGerman : t().switchToEnglish);
  // Keep a regional locale such as en-GB when its language is chosen again,
  // but let a visitor on an unsupported locale such as fr-FR, who reads the
  // English fallback, still choose English explicitly.
  const choose = (next: ProfilePreferenceLocale) => {
    if (canonicalLocale(locale())?.split("-")[0] !== next) setLocalePreference(next);
  };

  return (
    <Dropdown.Root
      label={t().language}
      position={props.position}
      width="10rem"
      items={[
        { label: t().switchToGerman, choice: "radio", checked: () => language() === "de", action: () => choose("de") },
        { label: t().switchToEnglish, choice: "radio", checked: () => language() === "en", action: () => choose("en") },
      ]}
    >
      <Dropdown.Trigger label={`${t().language}: ${languageName()}`} size={props.size} tooltip={false} variant="ghost">
        <i class="ti ti-language" aria-hidden="true" />
        <span class="max-md:hidden md:inline">{languageName()}</span>
        <span class="md:hidden">{language().toUpperCase()}</span>
        <i class="ti ti-chevron-down max-md:hidden md:inline" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
