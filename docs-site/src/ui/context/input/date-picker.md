# Date pickers

`DatePicker`, `DateTimePicker`, and `DateRangePicker` provide one controlled calendar interaction for date-only values, instants, and ranges. The parent owns the value and any preset choices.

## Use a date picker

Use `DatePicker` for a calendar date such as a birthday or due date.

Use `DateTimePicker` for one date and time. Set `optionalTime` when the
date alone is the normal case and a time is the exception, such as a task's
due date. Use `DateRangePicker` for a start and end, with `withTime` when both
endpoints include time.

## Type a date or pick one

`DatePicker` and a date-only `DateRangePicker` are text fields. People type a
date, or open the calendar and pick a day; both always show the same day.
Typing moves the open calendar to the typed month and marks the day, and
picking a day fills the text. `DateTimePicker`, a `DateRangePicker` with
`withTime`, and every `appearance="plain"` picker keep the calendar button.

The field understands a small, fixed set of inputs in German and English, in
every locale:

| Input | Means |
| --- | --- |
| `11.11.2026`, `11.11.26`, `11.11.`, `11.11` | A date in the locale's order of day, month and year; `11/11/2026` in `en-US`. Without a year, the current one. |
| `24`, `1111`, `111126`, `11112026` | Digits only, for the phone keypad: a day of this month, or day, month and year without separators. |
| `2026-11-11`, `11. November 2026`, `Nov 11, 2026` | ISO dates and month names. |
| `heute`, `morgen`, `gestern`, `übermorgen`, `today`, `tomorrow`, `yesterday` | That day. |
| `mi`, `Mittwoch`, `wed`, `wednesday` | The next Wednesday after today; today's weekday means the same day next week. |
| `+14`, `-3`, `+2w`, `+1m`, `+1j`, `heute +2 wochen`, `gestern + 34`, `mi +7`, `11.11. -3` | One offset at the end, counted from the date before it or from today: days by default, or `t`/`d`, `w`, `m`, `j`/`y`. Months end on the last day that exists. |

The field does not read sentences such as "in 2 Wochen"; it then suggests a
form that works.

Under the field, a status line always says which day is meant:

- at rest, the weekday and distance of the saved date, for example
  **Mittwoch, in 9 Tagen**;
- while typing, the absolute day that a commit would save and what the words
  meant, for example **→ Mi., 4. Nov. 2026 · nächster Mittwoch**;
- after a refused commit, the reason in red, for example **Der Februar 2026
  hat nur 28 Tage.**

The line keeps its height when it is empty, so typing, a mistake, or a
cleared value never moves the content below the field.

**Enter**, leaving the field, and picking a day commit. The text then shows the
date in the locale's numeric form: `+14` becomes `16.11.2026`. A refused text
stays for correction, the field reports `aria-invalid`, and the saved value
does not change. **Escape** restores the saved value. While typing, nothing is
red: an unfinished entry shows **…** or **Noch kein Datum**, and a definite
mistake already names its reason in the normal text color.

A click into the text opens the calendar and keeps the caret; reaching the
field with **Tab** does not. **↓** or **Alt+↓** opens the calendar with the
focus on the day; **Escape** or **Alt+↑** there returns to the text and keeps
it. The calendar opens below the status line, so the meant day stays visible.
On a phone the text brings up the numeric keypad, and the calendar button
opens the calendar as a bottom sheet with touch-sized days.

A date-only `DateRangePicker` has a start and an end field in one box, with
the range and its length in the status line. A pasted range such as
`11.11. – 14.11.` or `11.11. bis 14.11.` fills both. The calendar keeps two
clicks and **Apply**.

Set `min` and `max` as date keys to limit the days. The calendar locks the
other days and months and names the limits in its footer; a typed day outside
them is refused with the nearest allowed day, for example **Spätestens am
30.11.2026.** `readOnly` shows the value with a lock instead of the calendar
button and keeps the field focusable. An `error` from the form appears in the
status line while nobody is typing.

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

With `optionalTime`, `DateTimePicker` emits a date key such as `2026-10-24`
until a time is added, and the date-time form above with a time.

`DateRangePicker` uses `{ start, end }`. Both values are date keys unless `withTime` is enabled, in which case they follow the `DateTimePicker` rules.

Pass the value directly or through a Solid accessor. Applying a selection or
clearing reports the complete next value through both `onValueChange` and
`onValueCommit`. Clearing emits `null` for a single picker or
`{ start: null, end: null }` for a range.

## Show a date in a property row

Set `appearance="plain"` when the date is a property shown in a
[`DescriptionList` row](/en/ui/surfaces/details), such as a task's due date.
The trigger then reads as text, without box, calendar icon, or chevron, and the
whole row opens the panel; see [plain selects](/en/ui/input/select#show-a-value-in-a-property-row)
for the shared row behavior. A `clearable` plain picker clears from a
**Clear date** button in the panel footer instead of beside the value. The
empty value shows `placeholder` in muted text.

A plain `DatePicker` and `DateTimePicker` accept `renderValue(value)` for the
trigger content of a set value, for example the date followed by a relative
hint. The panel and the emitted value are unchanged. In a typed `DatePicker`,
`renderValue` replaces the resting status line under the field; while someone
types, the line still shows the meant day.

```tsx
<DateTimePicker
  aria-label="Due"
  appearance="plain"
  placeholder="No due date"
  clearable
  value={due}
  onValueChange={setDue}
  renderValue={(value) => (
    <>
      {formatDateTime(value)} <span class="text-dimmed">· {formatTimeSpan(value)}</span>
    </>
  )}
/>;
```

## Add a time only when needed

With `optionalTime`, the panel ends with **Add time** (**Uhrzeit
hinzufügen**) beside **Apply**. Without a time, choosing a day applies it and
closes the panel, as in `DatePicker`. **Add time** turns the button into the
time field with a **Remove time** button and moves the focus into the field;
a day then only marks the date until **Apply**. **Remove time** brings the
button back with the focus on it, and **Apply** saves the date alone. Both
states have the same height in the same place, so the panel never moves. The
time starts at `defaultTime` (`09:00` unless set), and a set value opens in
its own state. The trigger shows the calendar icon for a date and the
calendar-with-clock icon for a date with a time.

Presets in this mode can mix both forms, for example a date key for
**Tomorrow**.

```tsx
const [due, setDue] = createSignal<string | null>("2026-10-24");

<DateTimePicker
  label="Due"
  optionalTime
  defaultTime="17:00"
  value={due}
  onValueChange={setDue}
  dateConfig={{ timeZone: "Europe/Berlin" }}
  clearable
/>;
```

## Presets and ranges

One click picks a complete one-day range. The next click on another day extends
it; the earlier day becomes the start. If you are used to selecting both endpoints,
those two clicks still pick the same range, but a one-day range now needs only
one click before **Apply**. Clicking that same day again keeps it. After an
extension, the next click starts a new one-day range; reopening the panel also
starts a fresh selection. Hover or focus previews an extension until you pick
the second day.

The date-only duration in the footer uses the date locale, for example
**1 day** / **3 days** in English and **1 Tag** / **3 Tage** in German.

`presets` contains caller-defined labels and complete values. The components do not provide a fixed preset list.

`datePresets` changes the selected date without closing the picker and applies to every `DateRangePicker`. `durationPresets` changes the end from the current start by a number of minutes and appears only with `withTime`.

Use `dateConfig` to define the application time zone and first day of the week. Without a supplied week start, the calendar starts on Monday.

An explicit `dateConfig.locale` wins; without one the pickers inherit the render locale from `LocaleProvider` or the browser's `<html lang>` (see the Locale and formatting page). The timezone never comes from the locale context.

## Weekend columns

Weekend columns have a shaded background, from the weekday labels through the
last week. They follow the locale's week data: Saturday and Sunday in `de-DE`,
Friday and Saturday in `he-IL`. Without available week data, Saturday and Sunday
are the fallback. The grid keeps the first day of the week from `dateConfig`;
the shading is background only and causes no layout shift.

## Today

Every calendar marks today: the day number in the accent color with a small
dot below it. A selected today keeps the filled selection, and its number and
dot take the fill's contrasting color. Today on a day outside the visible
month keeps the muted number of the other outside days, and only its dot takes
the accent color. The mark is drawn inside the day cell, so it never changes
the grid's size.

Today is the current date in `dateConfig.timeZone`, the zone the values use,
not in the server's or the device's zone. Without a time zone it is the runtime's
local date. An open page moves the mark when the next day starts in that zone,
also where a daylight saving change skips or repeats midnight. It also checks
the date again when a hidden tab becomes visible and when `dateConfig` changes.
The pickers have no built-in **Today** preset; add one through `presets` when a
form needs it.

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
  clearable?: boolean; appearance?: ChoiceAppearance; min?: string; max?: string; readOnly?: boolean;
};

type DatePickerProps = DatePickerBaseProps<string | null> & {
  renderValue?: (value: string) => JSX.Element;
};

type DateTimePickerProps = DatePickerBaseProps<string | null> & {
  renderValue?: (value: string) => JSX.Element; optionalTime?: boolean; defaultTime?: string;
};

type DateRangePickerProps = DatePickerBaseProps<DateRangeValue> & {
  withTime?: boolean; datePresets?: readonly DatePreset<string | null>[];
  durationPresets?: readonly DurationPreset[];
};
```

`DateContext` is defined under [date and locale options](/en/ui/content/intl#date-and-locale-options). `DatePicker` emits `YYYY-MM-DD`; without a timezone `DateTimePicker` emits `YYYY-MM-DDTHH:mm`, with a timezone it emits an ISO instant in UTC. With `optionalTime`, `DateTimePicker` emits `YYYY-MM-DD` for a date without time and the datetime contract with one. `DateRangePicker` follows the date contract by default and the datetime contract with `withTime=true`. Empty range endpoints are `null`, not an absent range object. Supply preset values in the same format as the controlled value.

`ChoiceAppearance` is `"field" | "plain"` and defaults to `"field"`. `renderValue` replaces the trigger content of a set value in a plain picker and the resting status line of a typed `DatePicker`. `min` and `max` are date keys and apply to every picker's calendar. A typed field's `placeholder` defaults to the locale's pattern, such as `TT.MM.JJJJ` or `MM/DD/YYYY`. `presets` applies complete values; `datePresets` picks individual dates in a timed range, and `durationPresets.minutes` adjusts its duration. Clearing is enabled unless `clearable={false}`. Week-start and locale follow `dateConfig`; `withTime` defaults to false.

## Accessibility

A typed field is a `combobox` with a dialog popup. It has one tab stop: the
calendar button is skipped by **Tab** and opened with **↓** from the text. The
status line describes the field, and a polite live region reads the meant day
in words about half a second after typing stops, for example "Mittwoch,
4. November 2026, nächster Mittwoch". Locked days are named "nicht wählbar"
(**not available**). The range fields are named **Start** and **End** after the
field label.

Provide a visible `label` or a specific placeholder. A plain trigger exposes dialog
and expanded state, and direct JSX descriptions and errors are connected to it.
A button's label replaces its content, so the trigger also names its shown
value, or the placeholder, as its description: a plain picker with
`aria-label="Due"` reads as **Due** followed by the date.

With `optionalTime`, **Add time** is a button with its visible name, and
the icon-only **Remove time** button carries that name as its label.

Calendar navigation has named previous and next controls. Selected days and active duration presets expose pressed state. Time fields receive start and end labels in a range.

Today's day carries `aria-current="date"`, and its name starts with **Today**
(**Heute** in German) in the date's locale, for example "Today, Friday,
October 9, 2026". Without a value the calendar's tab stop starts on today.

## Runtime

The field, its text, and its status line, or a plain trigger and its value, render in server HTML. A typed field renders its calendar only when it opens. Typing, opening the calendar, navigating dates, selecting presets, and applying time or range values require browser code.

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
