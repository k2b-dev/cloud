import { type JSX, Show, splitProps } from "solid-js";
import { Button, type ButtonProps } from "./Button";
import { Dropdown, type DropdownItem, type DropdownPosition } from "./Dropdown";

export type SplitButtonProps = ButtonProps & {
  /** Actions shown from the secondary menu trigger. */
  items: readonly DropdownItem[];
  /** Optional selection menu in place of the primary immediate action. */
  primaryItems?: readonly DropdownItem[];
  /** Accessible name for the primary selection menu. */
  primaryMenuLabel?: string;
  /** Secondary menu glyph; defaults to a chevron. */
  menuIcon?: JSX.Element;
  /** Accessible name and title for the icon-only menu trigger. */
  menuLabel: string;
  menuPosition?: DropdownPosition | (() => DropdownPosition);
  menuWidth?: string;
};

/** One primary button action with a separate menu of related alternatives. */
export function SplitButton(props: SplitButtonProps): JSX.Element {
  const [local, buttonProps] = splitProps(props, [
    "children",
    "primaryItems",
    "primaryMenuLabel",
    "menuIcon",
    "class",
    "disabled",
    "items",
    "loading",
    "menuLabel",
    "menuPosition",
    "menuWidth",
    "size",
    "variant",
  ]);
  const disabled = () => Boolean(local.disabled || local.loading);

  return (
    <Dropdown.Root
      class="k2b-split-button"
      disabled={disabled()}
      items={local.items}
      label={local.menuLabel}
      position={local.menuPosition ?? "bottom-left"}
      width={local.menuWidth}
    >
      <Show
        when={local.primaryItems}
        fallback={
          <Button
            {...buttonProps}
            class={`k2b-split-button__primary ${local.class ?? ""}`}
            disabled={local.disabled}
            loading={local.loading}
            size={local.size}
            variant={local.variant ?? "primary"}
          >
            {local.children}
          </Button>
        }
      >
        {(items) => (
          <Dropdown.Root
            items={items()}
            disabled={disabled()}
            class="k2b-split-button__primary-menu"
            position={local.menuPosition ?? "bottom-left"}
            width={local.menuWidth}
          >
            <Dropdown.Trigger
              disabled={disabled()}
              size={local.size}
              variant={local.variant ?? "primary"}
              label={local.primaryMenuLabel}
              class={`k2b-split-button__primary ${local.class ?? ""}`}
            >
              {local.children}
            </Dropdown.Trigger>
          </Dropdown.Root>
        )}
      </Show>
      <Dropdown.Trigger
        class="k2b-split-button__menu-trigger"
        disabled={disabled()}
        iconOnly
        label={local.menuLabel}
        size={local.size}
        title={local.menuLabel}
        variant={local.variant ?? "primary"}
      >
        {local.menuIcon ?? <i class="ti ti-chevron-down" aria-hidden="true" />}
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
