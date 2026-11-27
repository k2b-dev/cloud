# Dialogs and overlays

What stands above the page for a moment: a dialog for a short task, a question before something that cannot be taken back, and a toast that reports a deed with a way back. Each one closes the same way and gives the focus back to where it came from.

## Reference look

The example screens of this page showed a bare look, and agents copied it, so they were removed. Until rebuilt examples follow, build to the reference look: the v2 taste study (three screens before and after, its diagnosis and 13 rules) and its parts gallery (table, filter, settings, detail and info parts). The 13 rules stand with their numbers in the skill `k2b-ui`, `references/look.md`.

## Dialog or a page of its own?

### Dialog

- A short task that belongs to the page behind it: invite a person, save as a template.
- A few fields; the page stays where it was when it closes.
- On the phone the same dialog is a sheet.

### A page of its own

- A long form, or one a person comes back to: a new order, a record.
- It has an address, so reload, back and a link show it again.
- See [Forms and input](/en/ui/v2/forms-and-input).

## Parts

Each part in one line. Props are generated from the types of `@k2b/ui/v2`, so this list cannot fall behind the code.

### Dialog

The one dialog: 480 px in the middle of the window, a sheet from the bottom below 768 px, with a grip on its top edge (a swipe down closes it) and its close button in the head. Head, content and foot are parts of one thing; the content scrolls, and a hairline shows where more of it lies.

<Props of="Dialog" />

### Dialog.confirm

`await Dialog.confirm({ title, confirm })` asks before something that cannot be taken back and resolves `true` when the person agrees. An alert dialog without a close button, never a sheet.

<Props of="ConfirmOptions" />

### Toast

`const toast = useToast()` in the component, then `toast("„Regal Archiv“ gelöscht", { undo })`. One sentence for five seconds; `undo` adds "Rückgängig", `status` adds a sign, and `bad` is announced at once.

News that no element shows as it happens, such as a run that changed its state, is only said: `announce("Lauf 3 ist fertig.")` puts it in the live region that every `Workspace` brings; with several Workspaces the first one shown takes it. The same news twice is said twice, a burst is said as its last news and at least once a second, and said news leaves the region after five seconds. `{ assertive: true }` is for news that cannot wait, such as a run that failed.

<Props of="ToastOptions" />

### Popover

A panel or a hint behind a button; its parts and props are in [Actions and menus](/en/ui/v2/actions-and-menus).

## Not in v2 yet

A toast with "Erneut versuchen" for a deed that failed: the option `retry` comes with the filter bar ([#4136](https://github.com/k2b-dev/cloud/pull/4136)). Until then a failed deed says so with `status: "bad"` and the person does it again. A dialog with steps (a wizard) is not there either; write `// k2b-ui gap: dialog steps` at that place.

## Do and don't

### Do

- Give a dialog its own one primary in its foot, the main one last.
- Ask with `Dialog.confirm` only before what cannot be taken back; for the rest, do it and offer `undo` in the toast.
- Keep the open state of a dialog in the screen (`open` and `onOpenChange`).
- Write a toast as one sentence about the deed: "Jonas Wolf entfernt".

### Don't

- Open a dialog from a dialog; put the next step in the same one.
- Use a toast for a problem at a place; that is a `Notice` or `Failed` there.
- Confirm a dialog with `Workspace primary` or with a button on the page behind it.
- Return a Promise from a menu entry that opens `Dialog.confirm`; the menu would stay open and busy while it asks.

## Next

[States and notices](/en/ui/v2/states-and-notices)
