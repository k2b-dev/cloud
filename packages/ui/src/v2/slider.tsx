import { useLocale } from "../intl/locale";
import { useRange } from "./behavior/pickers";
import { useField } from "./controls";

export type SliderProps = {
  /** The number. With `onChange` the caller holds it; without, the slider keeps it. */
  value?: number;
  /** Called on every step of a drag or a key. */
  onChange?: (value: number) => void;
  /** Called once a drag or a key press ends, with the final number: for saving. */
  onCommit?: (value: number) => void;
  /** The smallest number (0 by default). */
  min?: number;
  /** The largest number (100 by default). */
  max?: number;
  /** The step between two numbers (1 by default). */
  step?: number;
  /** How the number reads at the end and for assistive technology, such as `{ style: "percent" }` or a unit. */
  format?: Intl.NumberFormatOptions;
  /** The name the number is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the slider stands without a Field. */
  label?: string;
  /** The number cannot be changed now: dimmed, the value still shown. */
  disabled?: boolean;
};

/**
 * A number on a range, such as a volume, a zoom or an opacity: a track with one round thumb in the control's 36 px, the
 * number as it reads at the end. Arrows, Page keys, Home and End move it; a phone's screen reader adjusts it with its
 * own gestures (the behaviour layer on the ui-sdk core).
 */
export const Slider = (props: SliderProps) => {
  const field = useField();
  const locale = useLocale();
  const initial = props.value ?? props.min ?? 0;
  const range = useRange(() => ({
    ...(props.onChange ? { value: props.value ?? props.min ?? 0 } : { defaultValue: props.value ?? props.min ?? 0 }),
    onValueChange: (next: number) => props.onChange?.(next),
    onValueCommit: (next: number) => props.onCommit?.(next),
    min: props.min,
    max: props.max,
    step: props.step,
    format: props.format,
    locale: locale(),
    disabled: props.disabled,
    name: props.name ?? field?.name,
    thumbInputId: field?.control,
  }));
  return (
    <range.Root
      class="k2-slider"
      data-k2-part="Slider"
      data-disabled={props.disabled ? "" : undefined}
      aria-label={field ? undefined : props.label}
      aria-labelledby={field?.label}
      aria-describedby={field?.described}
    >
      <range.Control class="k2-slider-control">
        <range.Track class="k2-slider-track">
          <range.Indicator class="k2-slider-fill" />
        </range.Track>
        <range.Thumb
          class="k2-slider-thumb"
          input={{
            get "aria-describedby"() {
              return field?.described;
            },
            get "aria-invalid"() {
              return field?.invalid ? "true" : undefined;
            },
            // a form's reset returns a native range input to its default; the default is the slider's first value, so
            // the input, the number shown and the value sent come back together
            ref: (element: HTMLElement) => {
              (element as HTMLInputElement).defaultValue = String(initial);
            },
          }}
        />
      </range.Control>
      <range.Value class="k2-slider-value">{(state: { text?: string }) => state.text ?? ""}</range.Value>
      <range.Input />
    </range.Root>
  );
};
