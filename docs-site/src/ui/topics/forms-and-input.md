# Forms and input

Fields people fill in and send. Every control stands in a `Field` that names it; an error stands at its field, a conflict blocks saving, and each page has one primary button.

## Reference look

The example screens of this page showed a bare look, and agents copied it, so they were removed. Until rebuilt examples follow, build to the reference look: the v2 taste study (three screens before and after, its diagnosis and 13 rules) and its parts gallery (table, filter, settings, detail and info parts). The 13 rules stand with their numbers in the skill `k2b-ui`, `references/look.md`.

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
- People to choose show their face: give an option a `person`; the option is still named by its words.
- With `multiple` several options can be chosen, as boxes; the form sends one entry for each.

### Select

- Many options, or options that come from data, such as customers.
- Takes little room; `placeholder` says what to pick.
- An option that cannot be chosen now is `disabled`; so is the whole select while it cannot be changed.
- A long address, such as a sender, keeps its start and its domain and gives way in the middle; the whole address is its hint.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code. Buttons are in [Actions and menus](/en/ui/v2/actions-and-menus).

### Field

Names one control with a label, a hint or an error, and "optional" or a unit, or one deed at the end of its label line (`action`, such as "Auf Standard zurücksetzen"); `Field.Row` puts fields side by side.

<Props of="Field Field.Row" />

### Input

A text field of one line or several (`multiline`), a number, an address or a search. A field of several lines shows `rows` lines at least (3 by default) and grows with its words up to ten lines, then it scrolls.

<Props of="Input" />

### Select

One choice from many options, in a list that opens.

<Props of="Select SelectOption" />

### TagsInput

Several short values, such as domains or server addresses, as chips in one field; Enter adds the typed text, `suggestions` offer values to pick. With `type="email"` it takes e-mail addresses: a comma, a semicolon or a paste of several turns them into chips, `Name <address>` and `"Berg, Anna" <address>` as well. A value is the address in the form it came in, and the same address in other letters is one chip. A text that is no address stays in the field with a sentence why, and the form is not sent until it is fixed. While a person types, an address becomes a chip when a separator closes it; the last one when they press Enter, paste or leave the field. Every `TagsInput` takes at most `max` values (200 addresses by default, as one To of Mail) and says how many it left out. Each chip's button is named for what it removes; Backspace in the empty field takes the last one back, and a status says what was added or removed.

<Props of="TagsInput" />

### ImageInput

One image with its preview, a button to choose or change it and one to remove it; a dropped or pasted file counts as chosen.

<Props of="ImageInput" />

### Slider

A number on a range, such as an opacity or a zoom, with the number as it reads at the end, followed by its `unit` (such as `px`); `onCommit` saves when a drag ends. On a phone the slider is 44 px high, so a finger takes it.

<Props of="Slider" />

### ColorInput

A colour: its swatch and code in one line, and the given swatches. The swatch opens a panel with a surface of saturation and brightness and a hue slider.

<Props of="ColorInput" />

### CodeInput

A one-time or pairing code, one box per character; a phone offers a code from a message.

<Props of="CodeInput" />

### DateInput

A day, typed as the person reads it ("24.11.2026", also "heute" or "+3"), or picked from the calendar its symbol opens. The form gets the date key; text that is no date marks the field and keeps the form from sending.

<Props of="DateInput" />

### DatePicker

One month of days to pick from, inside a popover or a sheet: the arrows by day and week, PageUp and PageDown by month, Home and End to the week's ends, the locale's names and first weekday, and always six weeks. With `time` it adds hour and minute.

<Props of="DatePicker" />

### Check

One thing on or off; `switch` when it acts at once. A `description` says under its words what turning it on does.

<Props of="Check" />

### Choice

One choice from a few options, all visible.

<Props of="Choice" />

## Not in v2 yet

- A time field: a time is an `Input` with a placeholder such as "09:00".
- `DateInput` takes no `disabled`.
- An image cropper: `ImageInput` makes a square picture of the chosen file, or what its `transform` returns.
- A template editor with a preview: until it ships, a field shows the v1 `TemplateEditor` in a `Dialog`.

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
