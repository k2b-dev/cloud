import { Band, Bar, Inline } from "@k2b/ui/v2";
import type { JSX } from "solid-js";

/**
 * The action line of a visitor form: its own deed at the end, in the flow of the column (a band that holds only its
 * bar stands as high as the bar). The other ways in (back to sign-in, the app, the password) are links of the form, in
 * its band. Only a second deed of the same form, such as declining the terms, stands at the start; then the line
 * wraps on a narrow phone instead of being cut.
 */
export function FormActions(props: { start?: JSX.Element; end: JSX.Element }) {
  return (
    <Band>
      <Bar start={props.start === undefined ? undefined : <Inline>{props.start}</Inline>} end={props.end} />
    </Band>
  );
}
