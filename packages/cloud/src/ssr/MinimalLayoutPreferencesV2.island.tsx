import { useLocale } from "@k2b/ui";
import { Menu } from "@k2b/ui/v2";
import { canonicalLocale } from "../shared/locale";
import { type ProfilePreferenceLocale, profilePreferenceLocale, setLocalePreference } from "../shared/locale-preference";
import type { CloudThemePreference } from "../shared/theme";
import { createPreferenceController, THEME_CYCLE } from "./preference-controller";

const iconName = (icon: string) => icon.replace(/^ti\s+ti-/, "");

/**
 * The visitor footer's language and theme on v2: two quiet menus that name the current choice. Choosing the other
 * language reloads the page in it; the theme applies at once. The same preferences as the v1 footer.
 */
export default function MinimalLayoutPreferencesV2(props: { initialTheme: CloudThemePreference }) {
  const locale = useLocale();
  const preferences = createPreferenceController(props.initialTheme, locale);
  const t = preferences.messages;
  const language = () => profilePreferenceLocale(locale());
  const languageName = () => (language() === "de" ? t().switchToGerman : t().switchToEnglish);
  // Keep a regional locale such as en-GB when its language is chosen again (as the v1 menu does).
  const choose = (next: ProfilePreferenceLocale) => {
    if (canonicalLocale(locale())?.split("-")[0] !== next) setLocalePreference(next);
  };
  const theme = () => preferences.themeOption(preferences.theme());
  return (
    <span data-footer-preferences="">
      <Menu
        label={`${t().language}: ${languageName()}`}
        icon="language"
        variant="ghost"
        items={[
          {
            title: t().language,
            choice: language(),
            onChoose: (value: string) => choose(value === "de" ? "de" : "en"),
            items: [
              { value: "de", label: t().switchToGerman },
              { value: "en", label: t().switchToEnglish },
            ],
          },
        ]}
      >
        {languageName()}
      </Menu>
      <Menu
        label={preferences.themeCycleLabel()}
        icon={iconName(theme().icon)}
        variant="ghost"
        items={[
          {
            title: theme().label,
            choice: preferences.theme(),
            onChoose: (value: string) => {
              const next = THEME_CYCLE.find((mode) => mode === value);
              if (next) preferences.setTheme(next);
            },
            items: THEME_CYCLE.map((mode) => ({
              value: mode,
              label: preferences.themeOption(mode).label,
              icon: iconName(preferences.themeOption(mode).icon),
            })),
          },
        ]}
      >
        {theme().label}
      </Menu>
    </span>
  );
}
