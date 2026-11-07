import { type JSX, splitProps } from "solid-js";
import { IconButton, type IconButtonProps } from "../actions/Button";

/** The one icon for "Details" in every app: a circle, so it never reads as the side panel's rectangle with an arrow. */
export const DETAILS_ICON = "ti ti-info-circle";

export type DetailsToggleProps = Omit<IconButtonProps, "children" | "variant"> & {
  /** Extra classes for the glyph, such as a text size in a dense toolbar. */
  iconClass?: string;
};

/**
 * An icon-only Details button for an app's own toolbar or reader head. It shows the selection fill while its panel
 * is open (`aria-expanded="true"`), without a border or shadow, like `AppWorkspace.Detail`'s own button.
 */
export function DetailsToggle(props: DetailsToggleProps): JSX.Element {
  const [local, rest] = splitProps(props, ["class", "iconClass"]);
  return (
    <IconButton {...rest} variant="ghost" class={local.class ? `k2b-details-toggle ${local.class}` : "k2b-details-toggle"}>
      <i class={local.iconClass ? `${DETAILS_ICON} ${local.iconClass}` : DETAILS_ICON} aria-hidden="true" />
    </IconButton>
  );
}
