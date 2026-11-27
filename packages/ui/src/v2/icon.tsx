import type { Status } from "./types";

// A module of its own, so a part that needs only a sign (the error fallback of every island) does not load the marks.

export type IconProps = {
  /** A Tabler icon name without the `ti-` prefix, such as `package`. */
  name: string;
  /** A name for assistive technology; without one the icon is decoration. */
  label?: string;
  tone?: Status | "ai" | "app" | "muted" | "subtle";
};

/** A Tabler icon. Its size comes from its place: 16 px in rows and bars, 20 px on a tile, 14 px among marks. */
export const Icon = (props: IconProps) => (
  <i
    class={`ti ti-${props.name} k2-icon`}
    data-k2-part="Icon"
    data-name={props.name}
    data-tone={props.tone}
    role="img"
    aria-label={props.label}
    aria-hidden={props.label ? undefined : "true"}
  />
);
