import { createMemo, type JSX, Show } from "solid-js";
import type { ButtonSize } from "../actions/Button";
import { Dropdown, type DropdownItem, type DropdownPosition } from "../actions/Dropdown";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { useUiMessages } from "../intl/messages";
import type { MaybeAccessor, ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";

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
  menuWidth?: string;
  name?: string;
};

export function SelectChip<T extends string | number = string>(props: SelectChipProps<T>): JSX.Element {
  const messages = useUiMessages();
  const meta = createFieldMeta(props.id);
  const value = () => resolveMaybeAccessor(props.value)!;
  const selected = () => props.options.find((option) => option.value === value());
  const triggerLabel = () => props["aria-label"] ?? (typeof props.label === "string" ? props.label : messages().chooseOption);
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
      disabled={props.disabled}
    >
      <Dropdown.Root
        position={props.position ?? "bottom-right"}
        /* Cloud opens this menu at `w-40`. */
        width={props.menuWidth ?? "10rem"}
        label={triggerLabel()}
        items={items()}
      >
        <Dropdown.Trigger
          appearance={props.iconOnly ? "button" : "plain"}
          id={meta.controlId}
          class={props.iconOnly ? undefined : "k2b-select-chip"}
          disabled={props.disabled}
          iconOnly={props.iconOnly}
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
            <span>{selected()?.label ?? props.placeholder ?? ""}</span>
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </Show>
        </Dropdown.Trigger>
      </Dropdown.Root>
      <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={value()} />}</Show>
    </Field>
  );
}

export default SelectChip;
