---
thumbnail: form
---

# Forms and input

Fields people fill in and send. Every control stands in a `Field` that names it; an error stands at its field, a conflict blocks saving, and each page has one primary button.

## A form on its own page

A new source with required fields, a range limit, an option and a switch. The server answered the last save with an error at the address and at the interval, and someone else changed the source meanwhile: the conflict is a `Notice` with a way out, and "Speichern" stays dimmed until it is solved. Switch the state: a fresh form, errors at their fields, and the save under way.

<Example recipe="form" height="600" default="Conflict" />

## A form beside a list

A new appointment, opened from the head's "Neuer Termin" as a `Pane detail`, so the week's appointments stay in view while it is filled in. The page keeps that one primary, so the form saves with a default button in its own footer. On the phone the form is the page, with one way back to the list. A form that opens over the page is a `Dialog`; see [Dialogs and overlays](/en/ui/v2/dialogs-and-overlays).

<Example recipe="form-detail" height="640" default="Filled" />

## Errors, conflicts and saving

- **At the field:** a server error or "Pflichtfeld." goes into the `error` of its field. It replaces the hint and marks the control.
- **Required and optional:** `required` keeps the form from being sent empty, and the label shows nothing for it. A field that may stay empty says "optional", or its unit, in `optional`.
- **Conflict:** what blocks the whole form, such as a change by someone else, is a `Notice tone="warn"` above the fields with the deed that solves it. The save button is `disabled` while it lasts.
- **Saving:** `Button busy` while the save runs. The button keeps its width and focus, and a second press does nothing.
- **One primary:** a form page without a head action has "Speichern" as its one primary in the footer `Bar`. A form beside a page with a head primary saves with a default button.

## Choice or select?

### Choice

- A few options (two to four), all visible at once.
- The person compares them before choosing, such as who does the work.
- Inside a `Field` the field's label is its question.

### Select

- Many options that the page has, such as the kinds of an order.
- Takes little room; `placeholder` says what to pick.
- An option that cannot be chosen now is `disabled`.

### LookupSelect

- Values that come from data the person searches, such as one customer of 412 or a person.
- Loads while the person types; one value or `multiple`; an optional one can be cleared ("Auswahl entfernen").
- Never a `Select` with a few of many entries, and never free text for a person.

One choice marks its option with a tick at the end of the row in all three, as a menu does; several values have their box first.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code. Buttons are in [Actions and menus](/en/ui/v2/actions-and-menus).

### Field

Names one control with a label, a hint or an error, and "optional" or a unit; `Field.Row` puts fields side by side.

<Props of="Field Field.Row" />

### Input

A text field of one line or several (`multiline`), a number, an address or a search. A `number` has no spinner and reads and shows the locale's numbers ("1.500,5" in German); the app and the form get the plain number ("1500.5"), and `min` and `max` keep a form from sending a number outside them. A fixed set of sizes (an interval, "7 / 30 / 90 Tage") is a `Select`, not a number.

<Props of="Input" />

### Select

One choice from many options, in a list that opens.

<Props of="Select SelectOption" />

### LookupSelect

One value, or several, from values the app loads while the person types: closed it reads like a `Select`, open it searches over the matches (a sheet on a small touch screen). In a `Field` it takes the label, name, hint, error and `required`; the form gets each chosen code, nothing while disabled.

<Props of="LookupSelect" />

### DateInput

A day, typed as the person reads it ("24.11.2026", also "heute" or "+3"), or picked from the calendar its symbol opens. The form gets the date key; text that is no date marks the field and keeps the form from sending.

<Props of="DateInput" />

### DatePicker

One month of days to pick from, inside a popover or a sheet: the arrows by day and week, PageUp and PageDown by month, Home and End to the week's ends, the locale's names and first weekday, and always six weeks. With `time` it adds hour and minute.

<Props of="DatePicker" />

### Check

One thing on or off; `switch` when it acts at once.

<Props of="Check" />

### Choice

One choice from a few options, all visible; an option may carry a quiet `hint` and be `disabled` alone. Held by the page (`value` and `onChange`), it shows the page's value again when the page refuses a press or decides later.

<Props of="Choice" />

## Not in v2 yet

- A time field: a time is an `Input` with a placeholder such as "09:00".
- `DateInput` takes no `disabled`.
- `Select` can dim single options (`SelectOption` `disabled`), but not the whole select.
- A multiline `Input` with a `value` shows empty in the server's page until the page comes alive ([#4148](https://github.com/k2b-dev/cloud/issues/4148)).

Until they ship, use the nearest part and write `// k2b-ui gap: …` at that place.

## Do and don't

### Do

- Put every control in a `Field` with a `label`; side by side in `Field.Row`, which stacks on the phone.
- Put an error at its field, and a conflict in a `Notice` that names the deed.
- End the form with a `Bar` right after the fields: "Abbrechen", then the save.
- Show `busy` while saving, and `disabled` while saving cannot work.

### Don't

- Write a red line of your own under the form.
- Mark required fields with a star; mark the optional ones.
- Add a second primary button beside the head's primary.
- Confirm a form with `Workspace primary`.

## Next

[Actions and menus](/en/ui/v2/actions-and-menus)
