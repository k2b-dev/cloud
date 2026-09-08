# CopyButton and remove buttons

`CopyButton` copies known text with short success feedback. `RemoveBtn` and its `RemoveButton` convenience alias provide a compact remove action. The parent owns removal confirmation and the mutation.

## Use copy and remove actions

Use `CopyButton` for identifiers, commands, links, or tokens already present in the UI.

Use `RemoveBtn` or `RemoveButton` for a compact row or token action. Use a labeled danger button when removal is the page's primary destructive action.

## Import

```tsx
import {
  CopyButton,
  RemoveBtn,
  RemoveButton,
} from "@k2b/ui";
```

## CopyButton

Pass the exact clipboard value through `text`. With `label`, the component shows text and changes it to “Copied” for about two seconds. Without `label`, it renders an icon button with a tooltip and live announcement. The default action is neutral rather than primary.

`class` replaces the default button classes when the surrounding surface needs a different action hierarchy.

`onCopied` runs after a successful write. `onCopyError` reports the browser error, but clipboard failures still reject the promise. Use the callback for visible recovery and keep the application's normal rejected-promise reporting in place. `resetAfter` changes the feedback duration.

## RemoveBtn

`ariaLabel` is required and should name the affected item. `onClick` runs immediately; the component does not ask for confirmation or perform a mutation.

`loading` replaces the icon with a spinner and disables the button. `disabled` prevents the action without showing progress.

`RemoveButton` accepts `label` as a convenience alias for `ariaLabel`; use `RemoveBtn` when the stricter required-label contract is preferable.

## Accessibility

Use a specific remove label such as “Remove Alice from project”, not “Delete”. Clipboard success is announced in icon-only mode.

If removal is destructive or difficult to reverse, confirm it before calling the mutation.

## Runtime

Both components require hydrated client code. `CopyButton` uses the browser clipboard helper and transient state; `RemoveBtn` delegates to its click handler.

## Example

```tsx
<CopyButton
  text={inviteUrl}
  label="Copy invite link"
  onCopied={() => setStatus("Invite link copied")}
  onCopyError={() => setStatus("Clipboard access failed")}
/>

<RemoveBtn
  ariaLabel="Remove API key"
  loading={remove.loading()}
  onClick={() => removeApiKey(key.id)}
/>;

<RemoveButton label="Remove attachment" onClick={removeAttachment} />;
```
