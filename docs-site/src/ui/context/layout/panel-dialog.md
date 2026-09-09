# PanelDialog

`PanelDialog` is the layout shell for a complex editor. It keeps the header and footer fixed while the body scrolls.

It does not open a dialog, own form state, validate fields, or save data.

## Use PanelDialog

Use it for editors with several related field groups or a stable action footer.

Use `prompts.form` for a small form. Use `prompts.dialog` for a simple picker. Use `SettingsModal` for tabbed resource settings.

## Import

```tsx
import {
  Button,
  confirmDiscardIfDirty,
  dialogCore,
  PanelDialog,
  panelDialogFixedOptions,
  panelDialogOptions,
  panelDialogWideOptions,
  panelDialogWorkspaceOptions,
  TextInput,
} from "@k2b/ui";
```

## Choose the dialog frame

Open the shell with `dialogCore.open`.

- `panelDialogOptions` fits one contained editor to its content.
- `panelDialogWideOptions` gives a multi-column editor more horizontal room.
- `panelDialogFixedOptions` keeps a stable height while tabs or progressive sections change.
- `panelDialogWorkspaceOptions` provides a large work area.

The corresponding `panelDialogPanelClass`,
`panelDialogWidePanelClass`, `panelDialogFixedPanelClass`, and
`panelDialogWorkspacePanelClass` exports are the panel-class strings inside
those option objects. Prefer the complete option objects with `dialogCore`. Use
a class export only when another compatible host asks for the panel class
separately.

`surface="contained"` is the default modal treatment. `surface="floating"` makes the header, footer, and each section separate paper surfaces for settings-style pages.

Use `PanelDialog.Section` for meaningful field groups. Keep the primary save action in `PanelDialog.Footer`.

Use `PanelDialog.Tabs` only for local views within the editor. Its `value` may
be direct or an accessor; the application updates it through `onValueChange`.

## Close ownership

The muted header uses a 20 px semibold title and a 13 px secondary subtitle.
Without a subtitle, the header uses a compact vertical inset and centers the
title beside its icon and actions. Headers with a subtitle keep their two-line,
top-aligned layout. Action touch targets keep their size.
Header, body, and footer share a 24 px horizontal inset. Keep filenames and
other long identifiers in the subtitle or body; both heading lines wrap.
Use whitespace to separate content when additional section frames add no meaning.

Pass the dialog's `close` callback to `PanelDialog.Header`. `closeDisabled`
temporarily disables that control, and `closeLabel` overrides its accessible
name.

If the editor can be dirty, call `confirmDiscardIfDirty` before closing. The application decides what counts as dirty.

Register that same handler with the render context's `setDismissHandler` so
Escape and backdrop clicks cannot bypass it. While saving, the handler should
leave the dialog open. Call `close` directly after a successful save; it is the
completion callback, not a discard request. Dismissal handlers may be async and
may open a confirmation subdialog. Repeated native dismiss requests are ignored
while that handler is pending. `cancelBehavior: "ignore"` still disables native
dismissal entirely.

`dialogCore` owns the backdrop, focus handling, and Escape behavior. Do not create a second dialog frame around `PanelDialog`.

## Accessibility

Give the header and every section a clear title and icon. Header actions need their own accessible names.

Tabs use pressed buttons inside a labelled group. Pass `ariaLabel` when the default `Dialog tabs` does not describe the choices. Disabled options remain visible but cannot be selected.

## Runtime

`PanelDialog` can render layout on the server, but the dialog host, tabs, close
controls, and form mutations require hydrated client code.

`confirmDiscardIfDirty` returns immediately when its boolean or accessor is
false. Otherwise it opens the package confirmation prompt and resolves to the
user's decision.

## Example

```tsx
await dialogCore.open<void>(
  (close, context) => {
    const requestClose = async () => {
      if (saving()) return;
      if (await confirmDiscardIfDirty(dirty)) close();
    };
    context.setDismissHandler(requestClose);
    return (
    <PanelDialog>
      <PanelDialog.Header
        title="Edit item"
        icon="ti ti-pencil"
        close={requestClose}
      />
      <PanelDialog.Body scrollPreserveKey="item-editor">
        <PanelDialog.Section
          title="Basics"
          icon="ti ti-id"
        >
          <TextInput
            label="Title"
            value={title()}
            onValueChange={setTitle}
          />
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" size="sm" onClick={requestClose}>Cancel</Button>
        <Button size="sm" onClick={save}>Save</Button>
      </PanelDialog.Footer>
    </PanelDialog>
    );
  },
  panelDialogOptions,
);
```
