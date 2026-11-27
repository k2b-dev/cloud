import { For, Show } from "solid-js";
import { usePopover } from "./behavior/overlays";
import { useColor } from "./behavior/pickers";
import { useControlMessages } from "./control-messages";
import { useField } from "./controls";

export type ColorInputProps = {
  /** The colour as `#rrggbb`. With `onChange` the caller holds it; without, the picker keeps it. */
  value?: string;
  /** Called on every change, with `#rrggbb`. */
  onChange?: (value: string) => void;
  /** Called once a drag, a typed colour or a press on a swatch ends: for saving. */
  onCommit?: (value: string) => void;
  /** Colours to pick at a press, such as the colours of the app's areas. */
  swatches?: readonly string[];
  /** The name the colour is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the picker stands without a Field. */
  label?: string;
  /** The colour cannot be changed now: dimmed, the colour still shown. */
  disabled?: boolean;
};

/**
 * A colour: its swatch and its code (any CSS colour typed in becomes `#rrggbb` on Enter), a surface of saturation and
 * brightness and a hue slider under it, and the given swatches; arrows move each thumb (the behaviour layer on the
 * ui-sdk core).
 */
export const ColorInput = (props: ColorInputProps) => {
  const field = useField();
  field?.group();
  const t = useControlMessages();
  const picker = usePopover(() => ({}));
  const color = useColor(() => ({
    ...(props.onChange ? { value: props.value ?? "#000000" } : { defaultValue: props.value ?? "#000000" }),
    onValueChange: (next: string) => props.onChange?.(next),
    onValueCommit: (next: string) => props.onCommit?.(next),
    disabled: props.disabled,
    name: props.name ?? field?.name,
  }));
  return (
    <color.Root
      class="k2-color"
      data-k2-part="ColorInput"
      data-disabled={props.disabled ? "" : undefined}
      aria-label={field ? undefined : props.label}
    >
      <span class="k2-color-head">
        {/* the colour as a swatch that opens the picker (area and hue) on a panel: a settings row stays one line */}
        <picker.Trigger class="k2-color-swatch" disabled={props.disabled} aria-label={t().pickColor}>
          <color.Swatch class="k2-color-fill" aria-hidden="true" />
        </picker.Trigger>
        <span class="k2-input" data-disabled={props.disabled ? "" : undefined}>
          <color.Input id={field?.control} aria-label={t().colorCode} aria-describedby={field?.described} />
        </span>
      </span>
      <picker.Popup class="k2-pop k2-color-pop" data-k2-part="Popover" side="bottom" align="start" sideOffset={4} collisionPadding={8}>
        <color.Area class="k2-color-area">
          <color.AreaThumb class="k2-color-thumb" aria-label={t().colorArea} valueText={(attrs) => t().areaValue(areaPercents(attrs))} />
        </color.Area>
        <color.Slider class="k2-color-hue" channel="hue">
          <color.SliderThumb
            class="k2-color-thumb"
            channel="hue"
            aria-label={t().hue}
            valueText={(attrs) => t().hueValue({ degrees: Math.round(Number(attrs["aria-valuenow"] ?? 0)) })}
          />
        </color.Slider>
      </picker.Popup>
      <Show when={props.swatches?.length}>
        <color.Swatches class="k2-color-swatches" aria-label={props.label ?? t().colorCode}>
          <For each={props.swatches}>
            {(swatch) => <color.SwatchItem class="k2-color-preset" value={swatch} aria-label={t().color({ value: swatch })} />}
          </For>
        </color.Swatches>
      </Show>
      <color.HiddenInput />
    </color.Root>
  );
};

/**
 * Saturation and brightness in percent, read from where core puts the thumb of the colour surface (`--area-x` and
 * `--area-y`, fractions of the surface): the words follow the colour core holds, also on black or white.
 */
const areaPercents = (attrs: Record<string, unknown>) => {
  const style = typeof attrs.style === "string" ? attrs.style : "";
  // the whole value up to the next declaration, read as a number (core may write 1e-7)
  const fraction = (axis: "x" | "y") => {
    const value = Number(new RegExp(`--area-${axis}:([^;]+)`).exec(style)?.[1]?.trim());
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  };
  return { saturation: Math.round(fraction("x") * 100), brightness: Math.round(fraction("y") * 100) };
};
