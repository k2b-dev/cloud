import { Button, IconButton } from "@k2b/ui";
import type { JSX } from "solid-js";

/**
 * The same button and tooltip as Dropdown.Trigger, without loading the menu implementation. It names no aria-controls:
 * the menu it would point to exists only once the real Dropdown replaces it on activation.
 */
export function HelpPanelMenuTrigger(props: {
  label: string;
  onClick?: JSX.EventHandler<HTMLButtonElement, MouseEvent>;
  onKeyDown?: JSX.EventHandler<HTMLButtonElement, KeyboardEvent>;
  onPointerEnter?: JSX.EventHandler<HTMLButtonElement, PointerEvent>;
  onPointerDown?: JSX.EventHandler<HTMLButtonElement, PointerEvent>;
  onFocus?: JSX.EventHandler<HTMLButtonElement, FocusEvent>;
}) {
  return (
    <span class="k2b-dropdown ">
      <IconButton {...props} class="k2b-dropdown__trigger " aria-expanded="false" aria-haspopup="menu" data-help-menu="">
        <i class="ti ti-dots" aria-hidden="true" />
      </IconButton>
    </span>
  );
}
export function HelpPanelSectionTrigger(props: { label: string }) {
  return (
    <span class="k2b-dropdown ">
      <Button
        aria-expanded="false"
        aria-haspopup="menu"
        aria-label={props.label}
        class=" k2b-dropdown__trigger "
        size="sm"
        tooltip={false}
        variant="secondary"
        data-help-sections=""
      >
        <i class="ti ti-list" aria-hidden="true" />
        <span>{props.label}</span>
        <i class="ti ti-chevron-down" aria-hidden="true" />
      </Button>
    </span>
  );
}
