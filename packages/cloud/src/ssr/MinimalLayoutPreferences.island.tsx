import { useLocale } from "@k2b/ui";
import type { CloudThemePreference } from "../shared/theme";
import { LanguageMenu } from "./LanguageMenu";
import { createPreferenceController } from "./preference-controller";
import { ThemeCycleButton } from "./ThemeCycleButton";

/** Language opens a menu; appearance cycles in place and keeps its accessible name below md. */
export default function MinimalLayoutPreferences(props: { initialTheme: CloudThemePreference }) {
  const locale = useLocale();
  const preferences = createPreferenceController(props.initialTheme, locale);

  return (
    <div class="minimal-layout-footer__preferences">
      <LanguageMenu preferences={preferences} position="top-right" size="sm" />
      <ThemeCycleButton preferences={preferences} size="sm" variant="ghost" compact />
    </div>
  );
}
