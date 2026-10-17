import { createComputed, createEffect, createMemo, type JSX, on, Show } from "solid-js";
import type { ButtonSize } from "../actions/Button";
import { Dropdown, type DropdownItem, type DropdownPosition } from "../actions/Dropdown";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import type { MaybeAccessor, ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import { useSelectMessages } from "./select-messages";

export type SelectChipOption<T extends string | number = string> = {
  value: T;
  label: string;
  description?: string;
  icon?: string;
  image?: string;
  disabled?: boolean;
};

export type SelectChipProps<T extends string | number = string> = ValueFieldProps<T> & {
  value: MaybeAccessor<T>;
  options: SelectChipOption<T>[];
  icon?: string;
  iconOnly?: boolean;
  size?: ButtonSize;
  placeholder?: string;
  position?: DropdownPosition;
  /** Exact menu width as a CSS length. Without it the menu sizes to its options, at least `10rem`. */
  menuWidth?: string;
  name?: string;
  /** Shows that a change from this chip is saving: the chip stays in place with
   *  its size, cannot be opened, is marked busy, and shows a spinner where its
   *  chevron (or, icon-only, its icon) is. */
  loading?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function SelectChip<T extends string | number = string>(props: SelectChipProps<T>): JSX.Element {
  const selectMessages = useSelectMessages();
  const meta = createFieldMeta(props.id);
  const value = () => resolveMaybeAccessor(props.value)!;
  const selected = () => props.options.find((option) => option.value === value());
  const disabled = createMemo(() => Boolean(props.disabled || props.loading));
  // A disabled button loses focus, so a chip disabled while a change saves (its own or one elsewhere) would leave
  // keyboard focus on the page. Focus returns to the chip once it is enabled again, unless it has moved on
  // meanwhile. The check runs as a computation, before the DOM update disables the button.
  let trigger: HTMLButtonElement | undefined;
  let refocus = false;
  createComputed(
    on(
      disabled,
      (isDisabled) => {
        if (isDisabled) refocus = trigger !== undefined && document.activeElement === trigger;
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      disabled,
      (isDisabled) => {
        if (isDisabled || !refocus) return;
        refocus = false;
        const active = document.activeElement;
        if (trigger?.isConnected && (active === null || active === document.body)) trigger.focus();
      },
      { defer: true },
    ),
  );
  const triggerLabel = () => props["aria-label"] ?? (typeof props.label === "string" ? props.label : selectMessages().chooseOption);
  const items = createMemo<DropdownItem[]>(() =>
    props.options.map((option) => ({
      action: () => commitFieldValue(props, option.value),
      checked: () => option.value === value(),
      choice: "radio" as const,
      class: "k2b-select-chip__option",
      description: option.description,
      disabled: option.disabled,
      icon: option.icon,
      image: option.image,
      label: option.label,
    })),
  );

  return (
    <Field
      class={props.class}
      label={props.label}
      description={props.description}
      error={props.error}
      meta={meta}
      required={props.required}
      disabled={disabled()}
    >
      <Dropdown.Root
        // A controlled `open` cannot bypass a disabled or saving chip.
        open={props.open === undefined ? undefined : props.open && !disabled()}
        onOpenChange={props.onOpenChange}
        disabled={disabled()}
        position={props.position ?? "bottom-right"}
        /* Cloud opens this menu at `w-40`; the stylesheet keeps that as its floor. */
        width={props.menuWidth}
        menuClass="k2b-select-chip__menu"
        label={triggerLabel()}
        items={items()}
      >
        <Dropdown.Trigger
          appearance={props.iconOnly ? "button" : "plain"}
          id={meta.controlId}
          ref={(element: HTMLButtonElement) => {
            trigger = element;
          }}
          class={props.iconOnly ? undefined : "k2b-select-chip"}
          disabled={disabled()}
          aria-busy={props.loading ? "true" : undefined}
          iconOnly={props.iconOnly}
          loading={props.iconOnly ? props.loading : undefined}
          label={triggerLabel()}
          size={props.iconOnly ? props.size : undefined}
          title={props.iconOnly ? triggerLabel() : undefined}
          {...fieldControlAria(meta, props)}
        >
          <Show
            when={selected()?.image}
            fallback={<Show when={selected()?.icon ?? props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}
          >
            {(image) => <img src={image()} alt="" />}
          </Show>
          <Show when={!props.iconOnly}>
            <span data-placeholder={selected() ? undefined : "true"}>{selected()?.label ?? props.placeholder ?? ""}</span>
            {/* Both glyphs are one icon wide, so a saving chip keeps its size. */}
            <i class={props.loading ? "ti ti-loader-2 k2b-spin" : "ti ti-chevron-down"} aria-hidden="true" />
          </Show>
        </Dropdown.Trigger>
      </Dropdown.Root>
      <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={value()} />}</Show>
    </Field>
  );
}

export default SelectChip;
