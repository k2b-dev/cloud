import { Band, Bar, Inline } from "@k2b/ui/v2";
import type { JSX } from "solid-js";

/**
 * The action line of a visitor form: the other way (use the app, back to sign-in) at the start, the form's own action
 * at the end. In the flow of the column, so on a narrow phone the end wraps below the start instead of being cut.
 */
export function FormActions(props: { start?: JSX.Element; end: JSX.Element }) {
  return (
    <Band>
      <Bar start={<Inline>{props.start}</Inline>} end={props.end} />
    </Band>
  );
}
