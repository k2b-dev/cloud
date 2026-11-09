import { useLocale } from "@k2b/ui";
import type { CloudThemePreference } from "../shared/theme";
import { LanguageMenu } from "./LanguageMenu";
import { createPreferenceController } from "./preference-controller";
import { ThemeCycleButton } from "./ThemeCycleButton";

/**
 * The signed-out header's two settings, the same at every width: the language as a menu that names it, and the
 * appearance as an icon that shows the current mode and switches to the next one with each click.
 */
export default function LayoutPreferences(props: { initialTheme: CloudThemePreference }) {
  const locale = useLocale();
  const preferences = createPreferenceController(props.initialTheme, locale);

  return (
    <div class="ml-1 flex items-center gap-1">
      <LanguageMenu preferences={preferences} position="bottom-left" />
      <ThemeCycleButton preferences={preferences} variant="ghost" iconOnly />
    </div>
  );
}
