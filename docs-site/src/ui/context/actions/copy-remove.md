# CopyButton and remove buttons

`CopyButton` copies known text with short success feedback. `RemoveButton` provides a compact remove action. The parent owns removal confirmation and the mutation.

## Use copy and remove actions

Use `CopyButton` for identifiers, commands, links, or tokens already present in the UI.

Use `RemoveButton` for a compact row or token action. Use a labeled danger button when removal is the page's primary destructive action.

## Import

```tsx
import {
  CopyButton,
  RemoveButton,
} from "@k2b/ui";
```

## CopyButton

Pass the exact clipboard value through `text`. With `label`, the component shows text and changes it to “Copied” for about two seconds. Without `label`, it renders an icon button with a tooltip and live announcement. The default action is neutral rather than primary.

`class` adds classes. Use `variant` (default `"ghost"`) and `size` (default `"sm"`) to change the button treatment. `iconOnly` overrides the default derived from whether `label` is present; `copiedLabel` overrides the success text.

`onCopyError(error: unknown)` reports a failed write; the click handler absorbs the rejection and does not show success. `onCopied(): void` reports success. `resetAfter` sets the feedback duration in milliseconds (default `2000`). `text` or its `value` alias is required; `text` wins when both are set.

## RemoveButton

`ariaLabel` is required and should name the affected item. `onClick` runs immediately; the component does not ask for confirmation or perform a mutation.

`loading` replaces the icon with a spinner and disables the button. `disabled` prevents the action without showing progress.

Normal native button attributes pass through. `ariaLabel: string` is required; there is no `label` alias. `loading` defaults to false.

## Accessibility

Use a specific remove label such as “Remove Alice from project”, not “Delete”. Clipboard success is announced in icon-only mode.

If removal is destructive or difficult to reverse, confirm it before calling the mutation.

## Runtime

Both components require hydrated client code. `CopyButton` uses the browser clipboard helper and transient state; `RemoveButton` delegates to its click handler.

## Example

```tsx typecheck
import { CopyButton, RemoveButton } from "@k2b/ui";
import { createSignal } from "solid-js";

export function AttachmentActions(props: { url: string; remove: () => void }) {
  const [status, setStatus] = createSignal("");
  return (
    <div>
      <CopyButton text={props.url} label="Copy attachment link"
        onCopied={() => setStatus("Link copied")}
        onCopyError={() => setStatus("Clipboard access failed")} />
      <RemoveButton ariaLabel="Remove attachment" onClick={props.remove} />
      <span role="status">{status()}</span>
    </div>
  );
}
```
