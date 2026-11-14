# Period picker

`PeriodPicker` is one control for the period an evaluation or a dashboard
shows: presets such as **This month** plus a custom range, picked in the same
popover.

## Use a period picker

Use it in a card or page header where people switch what a view covers. Use
`DateRangePicker` when the value is always two explicit days, for example a
booking window in a form.

## Import

```tsx
import { PeriodPicker, type PeriodValue, periodPresets, resolvePeriod } from "@k2b/ui";
```

## Choose presets

The app passes its presets in list order. Built-in presets bring translated
labels and cover their whole calendar period: **This month** is the 1st to the
last day of the month, not the 1st to today.

| Preset | Days on Saturday, 7 November 2026 |
| --- | --- |
| `periodPresets.today`, `yesterday` | 7 Nov, 6 Nov |
| `periodPresets.thisWeek`, `lastWeek` | 2–8 Nov, 26 Oct–1 Nov (weeks start on `dateConfig.weekStartsOn`, Monday by default) |
| `periodPresets.thisMonth`, `lastMonth` | 1–30 Nov, 1–31 Oct |
| `periodPresets.thisQuarter`, `lastQuarter` | 1 Oct–31 Dec, 1 Jul–30 Sep |
| `periodPresets.thisYear`, `lastYear` | 2026, 2025 |
| `periodPresets.all({ since })` | `since` to today; without `since` the start stays open |

An app preset is `{ key, label, resolve }`. `resolve` receives
`{ today, weekStartsOn }` and returns inclusive date keys:

```tsx
const fiscalYear: PeriodPreset = {
  key: "fiscal-year",
  label: "Geschäftsjahr",
  resolve: ({ today }) => {
    const year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
    return { start: `${year}-04-01`, end: `${year + 1}-03-31` };
  },
};
```

Set `custom={false}` when a view offers presets only.

## Store the value

The value is a preset key, `{ preset: "this-month" }`, or two explicit days,
`{ start: "2026-11-01", end: "2026-11-07" }`. A stored preset stays relative:
**This month** saved in November shows December next month. Read a stored or
URL value with `parsePeriodValue(raw, presets)`; it returns `undefined` for a
key the list no longer has or for days that are not real or not in order.

An unknown preset key or `null` shows **Choose a period** in the trigger. The
picker never replaces a stored period with another one silently; the view
should say that its saved period is gone and let the person choose again.

## Resolve the same days on the server

`resolvePeriod(value, presets, { now, timeZone, weekStartsOn })` returns the
inclusive days, `{ start, end }`, where `null` marks an open edge. It returns
`undefined` for an unknown preset key. Today is read in `timeZone`, the zone the
data uses, not the browser's zone.

Query data with `periodInstants(range, timeZone)`. It returns `from`, the start
of the first day, and `to`, the start of the day after the last one, as ISO
instants; use `from <= t < to`. Days are never assumed to last 24 hours, so a
period across a daylight-saving change stays exact.

Pass the same `now` and `dateConfig` to the picker that the server used for
its query. The first render and the browser then show the same days, also
around midnight.

## Read the trigger

The trigger shows a preset with its days, **This month · Nov 1 – 30**, and
explicit days with their count, **11/01/2026 – 11/07/2026 · 7 days**. A
preset's days name the year only for a period outside the current year;
explicit days always carry it. The trigger keeps the width of its widest text,
every preset and the whole current year as explicit days, so a new choice never
moves the title or links beside it. A range across the turn of the
year may be wider; right-aligned in a header it grows to the left.

## Pick a custom range

**Custom range** opens the calendar beside the list in the same popover, with
two months when the window is wide enough and one otherwise. It starts with the
days of the selected preset. People click a first and a last day or type them
in **From** and **To**; a typed mistake shows its reason under the field and
keeps its place, so the calendar never moves. **Apply** saves the range; the
value does not change before that.

On a phone the trigger opens a bottom sheet. **Custom range** switches the
sheet to the calendar, and **Back to presets** returns to the list.

## API reference

```tsx
type PeriodValue = { preset: string } | { start: string; end: string };
type PeriodRange = { start: string | null; end: string | null };
type PeriodPreset = {
  key: string;
  label?: string;
  resolve: (context: { today: string; weekStartsOn: 0 | 1 }) => PeriodRange;
};

type PeriodPickerProps = Omit<ValueFieldProps<PeriodValue | null>, "value"> & {
  value: MaybeAccessor<PeriodValue | null>;
  presets: readonly PeriodPreset[];
  custom?: boolean;
  dateConfig?: DateContext;
  now?: Date;
  loading?: boolean;
};
```

`label` is optional: in a header, name the control with `aria-label`.
`loading` keeps the trigger's size, shows a spinner in place of the chevron,
and blocks opening while a change saves. Other exports: `periodPresets`,
`resolvePeriod`, `periodInstants`, `parsePeriodValue`, `periodContext`,
`periodDayCount`, `formatPeriodDays`, `formatPeriodRange`, and `isPeriodDay`.

## Accessibility

The trigger is a button with a dialog popup. Its name includes the shown
value, for example **Period: This month · Nov 1 – 30**. Opening moves focus to
the selected preset in a listbox; **↑**, **↓**, **Home**, and **End** move
through it, and **Enter** picks. **Custom range** opens the calendar grid,
where the arrow keys move between days and also into the second month,
**Page Up** and **Page Down** change the month, and each day carries its full
date as its name. **Tab** moves between the list, the fields, the calendar, and
**Apply**. **Escape** closes without a change and returns focus to the
trigger. Typed errors are linked to their field and set `aria-invalid`.

## Runtime

The trigger and its value render in server HTML. The list, the calendar, and
the phone sheet need browser code.

## Example

```tsx
const presets = [
  periodPresets.today,
  periodPresets.thisWeek,
  periodPresets.thisMonth,
  periodPresets.lastMonth,
  periodPresets.thisYear,
  periodPresets.all({ since: firstBookingDay }),
];
const [period, setPeriod] = createSignal<PeriodValue | null>({ preset: "this-month" });

<PeriodPicker
  aria-label="Zeitraum"
  value={period()}
  onValueChange={setPeriod}
  presets={presets}
  now={serverNow}
  dateConfig={{ timeZone: base.timezone, weekStartsOn: 1 }}
/>;
```
