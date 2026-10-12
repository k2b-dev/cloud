import { Dropdown, type DropdownPosition, useLocale } from "@k2b/ui";
import type { CloudTheme } from "../shared/theme";
import { createPreferenceController } from "./preference-controller";

type LayoutPreferencesProps = {
  initialTheme: CloudTheme;
  position: DropdownPosition;
};

export default function LayoutPreferences(props: LayoutPreferencesProps) {
  const locale = useLocale();
  const preferences = createPreferenceController(props.initialTheme, locale);

  return (
    <Dropdown.Root items={preferences.items()} label={preferences.messages().preferencesMenuLabel} position={props.position} width="14rem">
      <Dropdown.Trigger iconOnly label={preferences.messages().preferencesMenuLabel} size="sm" variant="secondary">
        <i class="ti ti-adjustments-horizontal" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
