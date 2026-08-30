import { Dropdown, type DropdownPosition, useLocale } from "@k2b/ui";
import type { CloudTheme } from "../shared/theme";
import { createPreferenceController } from "./preference-controller";

type LayoutPreferencesProps = {
  class?: string;
  initialTheme: CloudTheme;
  position: DropdownPosition;
  triggerClass?: string;
};

export default function LayoutPreferences(props: LayoutPreferencesProps) {
  const locale = useLocale();
  const preferences = createPreferenceController(props.initialTheme, locale);

  return (
    <Dropdown.Root
      class={props.class}
      items={preferences.items()}
      label={preferences.messages().preferencesMenuLabel}
      position={props.position}
      width="14rem"
    >
      <Dropdown.Trigger
        class={props.triggerClass}
        iconOnly
        label={preferences.messages().preferencesMenuLabel}
        size="sm"
        tooltip={false}
        variant="secondary"
      >
        <i class="ti ti-adjustments-horizontal" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
