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

## Settings with more than text

The sign-in settings of an app: a field that goes back to its default through the deed at the end of its label line, a choice the operator fixed (a dimmed `Select`), allowed domains as tags, a logo, an accent colour, how dark the background is, a code from another device, and questions that open in place. Switch the state: nothing set yet, and every control locked while a save runs or for a person who may only read.

<Example recipe="settings" height="760" />

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

- Many options, or options that come from data, such as customers.
- Takes little room; `placeholder` says what to pick.
- An option that cannot be chosen now is `disabled`; so is the whole select while it cannot be changed.

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code. Buttons are in [Actions and menus](/en/ui/v2/actions-and-menus).

### Field

Names one control with a label, a hint or an error, and "optional" or a unit, or one deed at the end of its label line (`action`, such as "Auf Standard zurücksetzen"); `Field.Row` puts fields side by side.

<Props of="Field Field.Row" />

### Input

A text field of one line or several (`multiline`), a number, an address or a search.

<Props of="Input" />

### Select

One choice from many options, in a list that opens.

<Props of="Select SelectOption" />

### TagsInput

Several short values, such as domains or server addresses, as chips in one field; Enter adds the typed text, `suggestions` offer values to pick.

<Props of="TagsInput" />

### ImageInput

One image with its preview, a button to choose or change it and one to remove it; a dropped or pasted file counts as chosen.

<Props of="ImageInput" />

### Slider

A number on a range, such as an opacity or a zoom, with the number as it reads at the end; `onCommit` saves when a drag ends.

<Props of="Slider" />

### ColorInput

A colour: its swatch and code, a surface of saturation and brightness, a hue slider and the given swatches.

<Props of="ColorInput" />

### CodeInput

A one-time or pairing code, one box per character; a phone offers a code from a message.

<Props of="CodeInput" />

### DateInput

A day, typed as the person reads it, with a calendar symbol.

<Props of="DateInput" />

### Check

One thing on or off; `switch` when it acts at once.

<Props of="Check" />

### Choice

One choice from a few options, all visible.

<Props of="Choice" />

## Not in v2 yet

- A time field: a time is an `Input` with a placeholder such as "09:00".
- `DateInput` has no picker yet and takes no `disabled`.
- An image cropper: `ImageInput` makes a square picture of the chosen file, or what its `transform` returns.
- A template editor with a preview: until it ships, a field shows the v1 `TemplateEditor` in a `Dialog`.
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
