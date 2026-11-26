import { Band, Bar } from "@k2b/ui/v2";
import type { JSX } from "solid-js";

/**
 * The action line of a visitor form: its own deed at the end, in the flow of the column (a band that holds only its
 * bar stands as high as the bar). The other ways (back to sign-in, the app, the password) are links of the form, in
 * its band, so this line never wraps on a phone.
 */
export function FormActions(props: { end: JSX.Element }) {
  return (
    <Band>
      <Bar end={props.end} />
    </Band>
  );
}
