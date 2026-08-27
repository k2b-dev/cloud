import { type JSX, Show } from "solid-js";
import { colorTintStyle } from "../internal/color";
import { useUiMessages } from "../intl/messages";

export type TagSize = "sm" | "md" | "lg";

export type TagProps = {
  children: JSX.Element;
  color?: string | null;
  icon?: string;
  size?: TagSize;
  selected?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
  disabled?: boolean;
  class?: string;
};

/** Compact label presentation with optional color, icon, and remove action. */
export function Tag(props: TagProps): JSX.Element {
  const messages = useUiMessages();
  const hasIconSlot = () => props.selected !== undefined || Boolean(props.icon);
  const icon = () => (props.selected ? "ti ti-check" : (props.icon ?? "ti ti-check"));

  return (
    <span
      class={`k2b-tag ${props.class ?? ""}`}
      data-size={props.size ?? "md"}
      data-selected={props.selected ? "true" : undefined}
      style={colorTintStyle(props.color)}
    >
      <Show when={hasIconSlot()}>
        <i class={`${icon()} k2b-tag__icon`} data-placeholder={!props.selected && !props.icon ? "true" : undefined} aria-hidden="true" />
      </Show>
      <span class="k2b-tag__label">{props.children}</span>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            class="k2b-tag__remove"
            aria-label={props.removeLabel ?? messages().removeTag}
            disabled={props.disabled}
            onClick={remove()}
          >
            <i class="ti ti-x" aria-hidden="true" />
          </button>
        )}
      </Show>
    </span>
  );
}

export default Tag;
