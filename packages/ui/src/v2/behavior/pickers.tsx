/**
 * Slider and colour picker for v2, each one core primitive through the adapter: dragging, keys, a native range input
 * per thumb for screen readers on phones and the form value from core's `slider`; the colour area, the hue slider,
 * the text input that reads any CSS colour and preset swatches from core's `colorPicker`. The v2 primitives add the
 * look; no ui-sdk type crosses these exports.
 */
import { colorPicker } from "@ui-sdk/core/color-picker";
import { slider } from "@ui-sdk/core/slider";
import { type PartProps, part, type SlotComponent, slotComponent, usePrimitive } from "./adapter";

export type RangeOptions = {
  value?: number;
  defaultValue?: number;
  onValueChange?: (value: number) => void;
  /** Runs once a drag or a key press that changed the value ends: for saving. */
  onValueCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  name?: string;
  /** The id of the thumb's input, so the label of a field names it. */
  thumbInputId?: string;
  /** How the value reads, for screen readers and the value part. */
  format?: Intl.NumberFormatOptions;
  locale?: string;
};

export type RangeParts = {
  Root: SlotComponent;
  /** The area that takes pointer presses; the track and the thumb stand in it. */
  Control: SlotComponent;
  Track: SlotComponent;
  /** The filled part of the track, from the start to the thumb. */
  Indicator: SlotComponent;
  /** The one thumb, with its native range input inside. */
  Thumb: (props: PartProps) => ReturnType<SlotComponent>;
  /** The value as it reads. */
  Value: SlotComponent;
  /** The hidden input a form sends. */
  Input: SlotComponent;
};

/** One value on a range: one thumb. */
export function useRange(options: () => RangeOptions): RangeParts {
  const handle = usePrimitive(slider, () => {
    const { onValueChange, onValueCommit, ...rest } = options();
    return {
      ...rest,
      onValueChange: (value: number | number[]) => onValueChange?.(Array.isArray(value) ? (value[0] ?? 0) : value),
      onValueCommit: (value: number | number[]) => onValueCommit?.(Array.isArray(value) ? (value[0] ?? 0) : value),
    };
  });
  return {
    Root: slotComponent(handle, "root", "div"),
    Control: slotComponent(handle, "control", "div"),
    Track: slotComponent(handle, "track", "div"),
    Indicator: slotComponent(handle, "indicator", "div"),
    Thumb: (props) =>
      part(
        handle,
        "thumb",
        () => ({ index: 0 }),
        { ...props, children: part(handle, "thumb-input", () => ({ index: 0 }), {}, "input") },
        "div",
      ),
    Value: slotComponent(handle, "value", "output"),
    Input: slotComponent(handle, "input", "input"),
  };
}

export type ColorOptions = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onValueCommit?: (value: string) => void;
  disabled?: boolean;
  name?: string;
};

export type ColorParts = {
  Root: SlotComponent;
  /** Saturation across, brightness up. */
  Area: SlotComponent;
  AreaThumb: SlotComponent;
  /** The hue: pass `channel="hue"`. */
  Slider: SlotComponent;
  SliderThumb: SlotComponent;
  /** A text input that reads any CSS colour on Enter or blur. */
  Input: SlotComponent;
  /** The colour itself. */
  Swatch: SlotComponent;
  Swatches: SlotComponent;
  /** A preset colour: pass its `value`. */
  SwatchItem: SlotComponent;
  HiddenInput: SlotComponent;
};

export function useColor(options: () => ColorOptions): ColorParts {
  const handle = usePrimitive(colorPicker, () => ({ format: "hex", ...options() }));
  return {
    Root: slotComponent(handle, "root", "div"),
    Area: slotComponent(handle, "area", "div"),
    AreaThumb: slotComponent(handle, "area-thumb", "div"),
    Slider: slotComponent(handle, "slider", "div"),
    SliderThumb: slotComponent(handle, "slider-thumb", "div"),
    Input: slotComponent(handle, "input", "input"),
    Swatch: slotComponent(handle, "swatch", "span"),
    Swatches: slotComponent(handle, "swatches", "div"),
    SwatchItem: slotComponent(handle, "swatch-item", "button"),
    HiddenInput: slotComponent(handle, "hidden-input", "input"),
  };
}
