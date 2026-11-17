# TimeInput

`TimeInput` is a field for a clock time alone, such as the start and end of a
shift or an opening hour. The value is a 24-hour time `HH:mm` or `null`. The
parent owns the value and decides when to persist it.

## Use TimeInput

Use it when the date is known or does not matter: opening hours, the start and
end of a working day, a daily reminder time.

Use [`DateTimePicker`](/en/ui/input/date-picker) when the value is one moment on
one day, and `DateRangePicker` with `withTime` for a meeting from one moment to
another. Use [`NumberInput`](/en/ui/input/number) with a `min` suffix for a
duration such as 90 minutes; a duration is no clock time.

## Import

```tsx
import { TimeInput } from "@k2b/ui";
```

## Value and events

Pass `value` directly or as an accessor returning `string | null`. `null`
renders as an empty field.

People type with the numeric keypad. Short input means a full time: `9` and `09`
are 09:00, `930` and `0930` are 09:30, `9:5` is 09:05. A dot, `h` or a space
works as the separator, as in `9.30`. The text stays as typed until Enter or
leaving the field commits it; then the field shows `09:30`.

`onValueChange` and `onValueCommit` both receive the committed value, once per
commit and only when it changed. An emptied field commits `null`.

A committed time lets Enter submit the surrounding form, so a form reads the
new value. A value set from outside replaces the text unless someone is typing.

## Steps and bounds

- `step` is the minute grid a committed time snaps to, counted from `min` or
  from midnight. `step={15}` turns `9:07` into 09:00 and `9:08` into 09:15. A
  time that would round up to midnight takes the last grid line before it.
- `min` and `max` are the earliest and latest allowed times, `HH:mm`. Without
  `max`, 23:59 is the last time of the day.
- `max="24:00"` allows the end of the day, for "until midnight". It suits the
  end of a time range; a start never needs it.

## Refused input

A text that is no time, a time outside `min` and `max`, and an empty required
field are refused. The text stays for correction, the field turns red and says
why in its message slot, and the value does not change:

- **Not a time. Example: 09:30** for input such as `25` or `9:60`;
- **08:00 at the earliest.** and **18:00 at the latest.** with the bound;
- **Enter a time.** for an emptied required field.

Typing a text that means an allowed time removes the red at once. Escape
restores the saved value. A refused text keeps Enter, and its native custom
validity stops a validating form from submitting. A form with `noValidate`
checks its own values before it saves.

An app error passed as `error`, such as "The end is before the start.", shows
in the same slot while no own message stands there.

## States

- **Empty:** the placeholder `hh:mm`, or the app's own `placeholder`.
- **Disabled:** `disabled` greys the field and takes it out of the tab order.
- **Read only:** `readOnly` keeps the value readable and focusable.
- **Error:** see above. Digits are tabular, so times in a column line up.

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for
`FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`.

```ts
type TimeInputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "max" | "min" | "onChange" | "onInput" | "step" | "type" | "value" | keyof ValueFieldProps<string | null>
> &
  ValueFieldProps<string | null> & {
    min?: string;
    max?: string;
    step?: number;
  };
```

## Accessibility

Prefer a visible `label`; without one, pass `aria-label`. The input is a text
field with `inputmode="numeric"`, so phones show the number keypad. Its
description and message are connected to it, `aria-invalid` marks a refused or
app error, and a new message is announced once. The texts follow the inherited
locale (English and German).

## Runtime

The field renders in server HTML with its value. Reading short input, steps,
bounds, refusal and the callbacks need browser code.

## Example

```tsx
const [start, setStart] = createSignal<string | null>("09:30");
const [end, setEnd] = createSignal<string | null>("17:00");

<div class="grid grid-cols-2 gap-3">
  <TimeInput label="Start" value={start} onValueChange={setStart} step={15} required />
  <TimeInput
    label="End"
    value={end}
    onValueChange={setEnd}
    step={15}
    max="24:00"
    required
    error={start() && end() && end()! <= start()! ? "The end is before the start." : undefined}
  />
</div>;
```
