# Change list

`ChangeList` shows pending changes before they are saved, one line each, so a
person can check them in one look: who gains something, what changes from what
to what, and who loses something.

## Use change lists

Use it under an editor that collects changes and saves them together, such as
the access dialog. Give each line a tone: `add` for something gained, `change`
for a different value, `remove` for something taken away, `neutral` for a
setting, and `warning` for a change with a consequence for others. The icon
repeats the tone without colour (plus, arrows, minus); `icon` replaces it.
Write the line as a sentence with the name in bold, and use `detail` for one
quiet consequence, such as "Anyone with the link sees this, also without
signing in."

Show the list only while something is pending, and keep the count next to the
save action so the list can collapse without hiding how much is open.

## Import

```tsx
import { ChangeList } from "@k2b/ui";
```

## API reference

```ts
type ChangeTone = "add" | "change" | "remove" | "neutral" | "warning";
type ChangeListItem = { tone: ChangeTone; icon?: string; content: JSX.Element; detail?: JSX.Element };
type ChangeListProps = { items: readonly ChangeListItem[]; label: string; class?: string };
```

## Accessibility

The list carries `label` as its name. Tones are never the only signal: each line
says what happens in words.

## Example

```tsx
<ChangeList
  label="What changes"
  items={[
    { tone: "add", content: <><b>Tom Becker</b> gets Edit</> },
    { tone: "change", content: <><b>Lea Schmitt</b>: View → Edit</> },
    { tone: "remove", content: <><b>Lagerbot</b> loses access</> },
  ]}
/>
```
