import { For, Show } from "solid-js";
import { useCode } from "./behavior/code";
import { useField } from "./controls";

export type CodeInputProps = {
  /** The code. With `onInput` the caller holds it; without, the field keeps it. */
  value?: string;
  onInput?: (value: string) => void;
  /** The last box is filled: the whole code, such as to check it at once. */
  onComplete?: (value: string) => void;
  /** How many characters the code has, one box each (6 by default). */
  length?: number;
  /** Which characters it takes: `digits` (the default, with the number keyboard on a phone) or `alphanumeric`. */
  characters?: "digits" | "alphanumeric";
  /** The name the value is sent under in a form; the field's name by default. */
  name?: string;
  /** A name when the code stands without a Field. */
  label?: string;
  disabled?: boolean;
  /**
   * What the browser may fill in: `one-time-code` (the default) lets a phone offer the code from a message and a
   * password manager fill it; `off` for a code shown on another device, such as a pairing code.
   */
  autocomplete?: "one-time-code" | "off";
};

/**
 * A one-time or pairing code: a box per character (36 px, round like an input), one real input under them that takes
 * typing, pasting and autofill, and is what assistive technology hears and a form sends (the behaviour layer on the
 * ui-sdk core).
 */
export const CodeInput = (props: CodeInputProps) => {
  const field = useField();
  const length = () => props.length ?? 6;
  const code = useCode(() => ({
    ...(props.onInput ? { value: props.value ?? "" } : { defaultValue: props.value ?? "" }),
    onValueChange: (next: string) => props.onInput?.(next),
    onValueCommit: (next: string) => props.onComplete?.(next),
    maxLength: length(),
    pattern: props.characters ?? "digits",
    autoComplete: props.autocomplete ?? "one-time-code",
    disabled: props.disabled,
    required: field?.required,
    name: props.name ?? field?.name,
  }));
  return (
    <code.Root
      class="k2-code"
      data-k2-part="CodeInput"
      data-invalid={field?.invalid ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
    >
      <code.Control
        id={field?.control}
        aria-label={field ? undefined : props.label}
        aria-invalid={field?.invalid ? "true" : undefined}
        aria-describedby={field?.described}
      />
      <code.Group class="k2-code-boxes">
        <For each={Array.from({ length: length() }, (_, index) => index)}>
          {(index) => (
            <code.Slot index={index} class="k2-code-box">
              {(state: { char?: string | null; hasFakeCaret?: boolean }) => (
                <>
                  {state.char ?? ""}
                  <Show when={state.hasFakeCaret}>
                    <span class="k2-code-caret" />
                  </Show>
                </>
              )}
            </code.Slot>
          )}
        </For>
      </code.Group>
    </code.Root>
  );
};
