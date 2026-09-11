# Date pickers

`DatePicker`, `DateTimePicker`, and `DateRangePicker` provide one controlled calendar interaction for date-only values, instants, and ranges. The parent owns the value and any preset choices.

## Use a date picker

Use `DatePicker` for a calendar date such as a birthday or due date.

Use `DateTimePicker` for one date and time. Use `DateRangePicker` for a start and end, with `withTime` when both endpoints include time.

## Import

```tsx
import {
  DatePicker,
  type DatePickerProps,
  type DatePreset,
  DateRangePicker,
  type DateRangePickerProps,
  type DateRangeValue,
  DateTimePicker,
  type DateTimePickerProps,
  type DurationPreset,
} from "@k2b/ui";
import type { DateContext } from "@k2b/stdlib";
```

## Value formats

`DatePicker` reads and emits a date key such as `2026-07-27`.

`DateTimePicker` emits a local date-time string when no time zone is configured. With `dateConfig.timeZone`, it displays wall-clock time in that zone and emits an instant.

`DateRangePicker` uses `{ start, end }`. Both values are date keys unless `withTime` is enabled, in which case they follow the `DateTimePicker` rules.

Pass the value directly or through a Solid accessor. Applying a selection or
clearing reports the complete next value through both `onValueChange` and
`onValueCommit`. Clearing emits `null` for a single picker or
`{ start: null, end: null }` for a range.

## Presets and ranges

`presets` contains caller-defined labels and complete values. The components do not provide a fixed preset list.

`datePresets` changes the selected date without closing the picker and applies to every `DateRangePicker`. `durationPresets` changes the end from the current start by a number of minutes and appears only with `withTime`.

Use `dateConfig` to define the application time zone and first day of the week. Without a supplied week start, the calendar starts on Monday.

An explicit `dateConfig.locale` wins; without one the pickers inherit the render locale from `LocaleProvider` or the browser's `<html lang>` (see the Locale and formatting page). The timezone never comes from the locale context.

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for `FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`.

```ts
type DatePreset<T> = {
  label: string; value: T;
};

type DurationPreset = {
  label: string; minutes: number;
};

type DateRangeValue = {
  start: string | null; end: string | null;
};

type DatePickerBaseProps<T> = Omit<ValueFieldProps<T>, "value"> & {
  placeholder?: string; value: MaybeAccessor<T>; presets?: readonly DatePreset<T>[]; dateConfig?: DateContext;
  clearable?: boolean;
};

type DatePickerProps = DatePickerBaseProps<string | null>;

type DateTimePickerProps = DatePickerBaseProps<string | null>;

type DateRangePickerProps = DatePickerBaseProps<DateRangeValue> & {
  withTime?: boolean; datePresets?: readonly DatePreset<string | null>[];
  durationPresets?: readonly DurationPreset[];
};
```

`DateContext` is defined under [date and locale options](/en/ui/content/intl#date-and-locale-options). `DatePicker` emits `YYYY-MM-DD`; without a timezone `DateTimePicker` emits `YYYY-MM-DDTHH:mm`, with a timezone it emits an ISO instant in UTC. `DateRangePicker` follows the date contract by default and the datetime contract with `withTime=true`. Empty range endpoints are `null`, not an absent range object. Supply preset values in the same format as the controlled value.

`presets` applies complete values; `datePresets` picks individual dates in a timed range, and `durationPresets.minutes` adjusts its duration. Clearing is enabled unless `clearable={false}`. Week-start and locale follow `dateConfig`; `withTime` defaults to false.

## Accessibility

Provide a visible `label` or a specific placeholder. The trigger exposes dialog
and expanded state, and direct JSX descriptions and errors are connected to it.

Calendar navigation has named previous and next controls. Selected days and active duration presets expose pressed state. Time fields receive start and end labels in a range.

## Runtime

The trigger and current value render in server HTML. Opening the calendar, navigating dates, selecting presets, and applying time or range values require hydrated Solid client code.

## Example

```tsx
const dateConfig: DateContext = {
  timeZone: "Europe/Berlin",
  weekStartsOn: 1,
};

const [startsAt, setStartsAt] = createSignal<string | null>(null);

<DateTimePicker
  label="Starts at"
  placeholder="Pick date and time"
  value={startsAt()}
  onValueChange={setStartsAt}
  dateConfig={dateConfig}
  clearable
/>;
```
