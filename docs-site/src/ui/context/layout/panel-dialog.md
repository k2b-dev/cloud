# PanelDialog

`PanelDialog` is the layout shell for a complex editor. It keeps the header and footer fixed while the body scrolls.

`PanelDialog.Body` adds top/bottom overflow fades only where more content remains.
The header and footer stay unmasked. Set `scrollFade={false}` on the body for
an unmasked surface; do not add a second scroll wrapper. Fades update when
sections expand, content changes, or the dialog resizes, and are disabled in
forced-color mode.

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

Pass `hideable` to a section for optional settings. Closed sections show a flat
summary row with an eye icon at the trailing edge. Open sections use the normal
section border, background, heading, and content inset, with an eye-off button
at the upper right. This changes section visibility, not the dialog's `surface`.

```tsx
<PanelDialog.Section hideable title="Connection" subtitle="API settings" icon="ti ti-plug">
  <TextInput label="Base URL" value={baseUrl()} onValueChange={setBaseUrl} />
</PanelDialog.Section>
```

Hideable sections start closed. Use `defaultOpen` to start expanded, or control
them with `open` and `onOpenChange`. The callback requests a change; the owner
can refuse it or open a section after a validation error. `disabled` blocks the
toggle, not the fields. Children stay mounted so unsaved edits survive closing.
Keyboard focus moves to the visible toggle when the focused control is hidden.
Ordinary sections keep their existing appearance and behavior.


Footer children can move onto separate rows when space is limited. Put a hint
first and the action group last: the group keeps its width and moves below the
hint before its buttons are squeezed. A trailing flex group containing direct
buttons can also wrap whole buttons when they cannot fit across the footer on
their own.

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

## API reference

```ts
type PanelDialogSurface = "contained" | "floating";

type PanelDialogProps = {
  children: JSX.Element; surface?: PanelDialogSurface;
};

type PanelDialogHeaderProps = {
  title: JSX.Element; subtitle?: JSX.Element; icon?: string; actions?: JSX.Element; close?: () => void;
  closeDisabled?: boolean; closeLabel?: string;
};

type PanelDialogBodyProps = {
  children: JSX.Element; scrollPreserveKey?: string; scrollFade?: boolean;
};

type PanelDialogFooterProps = {
  children: JSX.Element;
};

type PanelDialogSectionProps = {
  title: JSX.Element; subtitle?: JSX.Element; icon?: string; actions?: JSX.Element; children: JSX.Element;
} & (
  | { hideable?: false; open?: never; defaultOpen?: never; onOpenChange?: never; disabled?: never }
  | { hideable: true; open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; disabled?: boolean }
);

type PanelDialogTabOption<T extends string = string> = {
  value: T; label: JSX.Element; icon?: string; disabled?: boolean;
};

type PanelDialogTabsProps<T extends string = string> = {
  options: readonly PanelDialogTabOption<T>[]; value: T | (() => T); onValueChange: (value: T) => void;
  ariaLabel?: string; label?: string;
};
```

Types map to the correspondingly named compound members. `PanelDialog` supplies geometry, not modal state. For `dialogCore.open` and its cancellation options see [Prompts](/en/ui/feedback/prompts#api-reference). `Tabs` accepts a string value or accessor; the parent applies `onValueChange`.

## Accessibility

Give the header and every section a clear title and icon. Header actions need their own accessible names.

Tabs use tab triggers inside a labelled tab list. Pass `ariaLabel` when the default `Dialog tabs` does not describe the choices. Disabled options remain visible but cannot be selected.

## Runtime

`PanelDialog` can render layout on the server, but the dialog host, tabs, close
controls, hideable sections, and form mutations require hydrated client code.

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
