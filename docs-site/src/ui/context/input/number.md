# NumberInput

`NumberInput` is an accessor-controlled numeric field with an explicit empty
state. The parent owns the number and decides when to persist it.

## Use NumberInput

Use it for counts, limits, percentages, currency amounts, and other numeric form values.

Use `TextInput` when the value is an identifier that only looks numeric, such as an account number or postal code.

## Import

```tsx
import { NumberInput } from "@k2b/ui";
```

## Value and events

Pass `value` directly or as an accessor returning `number | null`. `null` and
an omitted value render as empty; callbacks emit `null` when the field is
cleared.

`onValueChange` receives the parsed value while the user types.
`onValueCommit` receives the normalized value after blur, Enter, a stepper
click, or the default clear action. Enter commits before an enclosing form
submits, so the form sends the normalized number.

The component keeps the typed text, separators included, until commit, so
intermediate input is not lost. A typed `12.` commits as `12`.

## Typed and pasted amounts

The effective locale decides which mark separates decimals and which groups
thousands. In German `2.977,17` commits `2977.17`; in English `2,977.17` does.

- Grouping marks count only in their places: one to three digits first, then
  groups of exactly three. `2.977` is `2977` in German, `2,977` in English.
- The other mark, where it cannot group, still reads as the decimal
  separator: `3.14` in German commits `3.14`, while `3.140` commits `3140`.
  The committed text shows which reading the field took.
- Text that fits neither reading stays in the field: `2,977.17` in German,
  `12,34,567` in English, a minus that is not leading such as `1.234,56-`,
  separators or a minus alone, and numbers too large to represent. The field
  shows its error state with an example of the expected form and commits
  nothing; Enter does not submit the form. Form validation reports the text as
  invalid already while it is typed. While the text is invalid,
  `onValueChange` reports the value from before the edit. Correcting the text,
  or a new `value` from the parent while the field is not focused, clears the
  error.
- Characters that cannot belong to a number, such as a currency sign or
  spaces, are dropped as they are typed or pasted.

## Numeric rules

- `decimalPlaces` defaults to the fraction digits of `step` (`step={0.01}` accepts two decimals, the default `step={1}` accepts none). Set it explicitly when the accepted precision differs from the step grid; an explicit value always wins.
- The visible decimal separator follows the effective locale (`locale` prop, then `LocaleProvider`, then `<html lang>`, then `"en"`). The controlled value stays a canonical JavaScript number and `aria-valuenow` stays numeric.
- Committed and unfocused values show exactly `decimalPlaces` fraction digits, including trailing zeros: `321.4` with `step={0.01}` displays as `321.40` in English and `321,40` in German. Extra typed fraction digits round on commit.
- Rounding and step snapping work on the decimal text, half away from zero, not on the binary float: `1.005` with `step={0.01}` commits `1.01`, `-1.005` commits `-1.01`. A shown value rounds the same way.
- Committed text never shows grouping separators.
- `allowNegative` defaults to `true`. With `allowNegative={false}`, a typed or pasted minus is refused with **No negative numbers.** instead of being dropped, and the floor is `0` for the steppers and commits (or `min` when it is higher).
- `min` and `max` clamp committed values.
- `step` defaults to `1` and snaps committed values to its grid.
- The default stepper buttons are integrated into the left and right edges of the input.
- `showSteppers={false}` hides the buttons without disabling typed input.
- `disableSteppers` disables only the buttons.
- The placeholder and numeric value are both right-aligned; the placeholder is visually quieter than entered values.

`prefix` and `suffix` display short units inside the field. `clearable` adds an explicit empty-state action.

## Edit a number in a property row

Set `appearance="plain"` when the number is a property shown in a
[`DescriptionList` row](/en/ui/surfaces/details), such as an estimate. The
value reads as text in the row's type, followed by its `suffix`, and the field
is exactly as wide as that text. There are no steppers or clear button: a click
anywhere in the row edits the value, Enter or leaving the field commits, Escape
restores the current value, and emptying the text clears it. Enter and Escape
keep focus in the field. The suffix hides while the field is empty, so the
placeholder reads alone. Commit through `onValueCommit`; leaving the field
fires it also when the value did not change, but not again right after Enter.

Pass `formatValue` to show a set value in a friendlier form while the field is
not being edited, such as `90` minutes as **1 h 30 min**. Editing shows the
plain number with its `suffix`; at rest the formatted text stands alone.

On touch devices the field edits at 16 px like every other input, so iOS does
not zoom. At rest the value keeps the row's size.

```tsx
<NumberInput
  aria-label="Estimate"
  appearance="plain"
  placeholder="No estimate"
  suffix="min"
  min={1}
  value={estimate}
  formatValue={formatDuration}
  onValueCommit={saveEstimate}
/>;
```

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for `FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`. A [suggestion](/en/ui/input/field-suggestion) is a number; Accept snaps it to `step`, `min`, and `max` like any commit.

```ts
type NumberInputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "max" | "min" | "onChange" | "onInput" | "prefix" | "step" | "type" | "value" | keyof ValueFieldProps<number | null>
> &
  ValueFieldProps<number | null> & {
    max?: number;
    min?: number;
    step?: number;
    decimalPlaces?: number;
    allowNegative?: boolean;
    clearable?: boolean;
    onClear?: () => void;
    clearLabel?: string;
    increaseLabel?: string;
    decreaseLabel?: string;
    locale?: string;
    showSteppers?: boolean;
    disableSteppers?: boolean;
    icon?: string;
    activeIcon?: string;
    prefix?: JSX.Element;
    suffix?: JSX.Element;
    appearance?: ChoiceAppearance;
    formatValue?: (value: number) => string;
  };
```

`appearance` defaults to `"field"`; with `"plain"`, `showSteppers` defaults to `false`. `formatValue` only changes the resting text of a plain field. `onClear` overrides the built-in reset to `null`; the host must then report its own value/commit update. `icon` and `activeIcon` replace the idle and focused icons.

## Accessibility

Prefer a visible `label`. Without one, the placeholder becomes the accessible name, with **Enter number** as the final fallback.

The input exposes spinbutton semantics and finite minimum, maximum, and current values. Refused text sets `aria-invalid` and announces its error like a reactive `error`. Its value text includes a string `suffix`, such as **45 min**, or the `formatValue` text; an explicit `aria-valuetext` wins. The stepper and clear controls have accessible names; override them per instance with `increaseLabel`, `decreaseLabel`, and `clearLabel` when the surrounding product is not English. Descriptions and reactive errors are connected to the field.

## Runtime

The field renders in server HTML. Input filtering, raw-text preservation, refusing unreadable text, steppers, clearing, and callbacks require browser code.

## Example

```tsx
const [price, setPrice] = createSignal<number | null>(12.5);

<NumberInput
  label="Price"
  value={price}
  onValueChange={setPrice}
  min={0}
  step={0.01}
  decimalPlaces={2}
  suffix="€"
  clearable
  showSteppers={false}
/>;
```
