import { safeColor } from "./colors";
import type { Status } from "./types";

// A module of its own, so a part that needs only a sign (the error fallback of every island) does not load the marks.

export type IconProps = {
  /** A Tabler icon name without the `ti-` prefix, such as `package`. */
  name: string;
  /** A name for assistive technology; without one the icon is decoration. */
  label?: string;
  tone?: Status | "ai" | "app" | "muted" | "subtle";
  /**
   * A data colour by meaning, such as the sun of a weather sign or the rain: a hex colour, an `oklch()`, a custom
   * property of the page or `light-dark()` of two of them, which the owner keeps at 3:1 on the surface in both themes.
   * It takes the place of `tone`; anything that is no colour is dropped.
   */
  color?: string;
};

/** A Tabler icon. Its size comes from its place: 16 px in rows and bars, 20 px on a tile, 14 px among marks. */
export const Icon = (props: IconProps) => {
  // the colour checked as every v2 data colour is (colors.ts, as `custom()` checks `--k2-c`), without loading the marks
  const color = () => safeColor(props.color);
  return (
    <i
      class={`ti ti-${props.name} k2-icon`}
      data-k2-part="Icon"
      data-name={props.name}
      data-tone={props.tone}
      data-color={color() === undefined ? undefined : ""}
      style={color() === undefined ? undefined : { "--k2-c": color() }}
      role="img"
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    />
  );
};
