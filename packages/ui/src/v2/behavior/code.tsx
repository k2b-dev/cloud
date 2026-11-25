/**
 * The behaviour of a one-time code for v2: one real input under drawn boxes, with paste, autofill from a message
 * (`autocomplete="one-time-code"`), the pattern of its characters, undo and the form input, from core's `otpInput`.
 * The v2 primitive adds the look; no ui-sdk type crosses these exports.
 */
import { otpInput } from "@ui-sdk/core/otp-input";
import { type PartProps, part, type SlotComponent, slotComponent, usePrimitive } from "./adapter";

export type CodeOptions = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Runs when the last box is filled, with the whole code. */
  onValueCommit?: (value: string) => void;
  maxLength?: number;
  pattern?: "digits" | "letters" | "alphanumeric";
  autoComplete?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
};

export type CodeParts = {
  /** Holds the boxes and the input over them. */
  Root: SlotComponent;
  /** The real input: it takes the focus, holds the code, is named and sent. */
  Control: SlotComponent;
  /** A run of boxes; drawn only, the input is what assistive technology hears. */
  Group: SlotComponent;
  /** One box: pass its `index` from 0. */
  Slot: (props: PartProps & { index: number }) => ReturnType<SlotComponent>;
};

export function useCode(options: () => CodeOptions): CodeParts {
  const handle = usePrimitive(otpInput, options);
  return {
    Root: slotComponent(handle, "root", "div"),
    Control: slotComponent(handle, "control", "input"),
    Group: slotComponent(handle, "group", "div"),
    Slot: (props) => {
      const { index, ...element } = props;
      return part(handle, "slot", () => ({ index }), element, "div");
    },
  };
}
