import { Tooltip } from "@k2b/ui";
import { railNameClipped } from "./rail-names";

/**
 * An app bar entry's hint, to its right at once. It names the entry only where its name is not fully visible:
 * always in the narrow app bar, and on wide windows only for a cut-off name.
 */
export function RailItemHint(props: { target: () => HTMLElement | undefined; content: string }) {
  return <Tooltip target={props.target} content={props.content} placement="right" delay={0} disabled={!railNameClipped(props.target())} />;
}
