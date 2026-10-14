import { type JSX, Show } from "solid-js";

export type LabelChipProps = { icon?: string; children: JSX.Element; class?: string };
/**
 * Names a UI control inside running text. The icon is a full class string.
 * @example <LabelChip icon="ti ti-share">Share</LabelChip>
 */
export function LabelChip(props: LabelChipProps): JSX.Element {
  return (
    <span class={`k2b-label-chip${props.class ? ` ${props.class}` : ""}`}>
      <Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>
      {props.children}
    </span>
  );
}
export default LabelChip;
