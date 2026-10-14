import { Button, type ButtonSize, type ButtonVariant } from "@k2b/ui";
import { type createPreferenceController, THEME_CYCLE } from "./preference-controller";

type Props = {
  preferences: ReturnType<typeof createPreferenceController>;
  variant: ButtonVariant;
  size?: ButtonSize;
  /** Shows only the icon below `md`; the accessible name still states the choice. */
  compact?: boolean;
};

/**
 * One button for the appearance: it shows the current choice and each click switches to the next. The label reserves
 * the width of the two other choices, so the button and its neighbors stay in place.
 */
export function ThemeCycleButton(props: Props) {
  const current = () => props.preferences.themeOption(props.preferences.theme());
  const otherLabels = () =>
    THEME_CYCLE.filter((value) => value !== props.preferences.theme()).map((value) => props.preferences.themeOption(value).label);

  return (
    <>
      <Button
        type="button"
        class="cloud-theme-cycle"
        variant={props.variant}
        size={props.size}
        aria-label={props.preferences.themeCycleLabel()}
        onClick={props.preferences.cycleTheme}
      >
        <i class={current().icon} aria-hidden="true" />
        <span
          class="cloud-theme-cycle__label"
          data-compact={props.compact ? "true" : undefined}
          data-reserve-a={otherLabels()[0]}
          data-reserve-b={otherLabels()[1]}
        >
          <span>{current().label}</span>
        </span>
      </Button>
      <span class="sr-only" aria-live="polite">
        {props.preferences.themeAnnouncement()}
      </span>
    </>
  );
}
