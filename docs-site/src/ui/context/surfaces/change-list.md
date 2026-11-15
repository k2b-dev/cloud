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

## Signs for a comparison

`marker="sign"` shows what a new version changes against the one before, as in
an approval: a bare sign per line on one text edge, `+` in the action colour
for something new, `−` for something gone, and `=` with the tone `same` for
what stays (often one line such as "5 more stay the same." with a link). Lines
use the 14px step; gone and same lines are quieter. `marks` add short quiet
words at the end of a line, such as "needs approval" with `ti ti-eye`, "new"
(`tone: "new"`, in the action colour) or "dropped" (`tone: "gone"`, an
outline). `detail` stays one quiet 12px line on the same edge. Marks use the
12px meta step at regular weight, so a line keeps at most three text styles.
The bare sign is hidden from assistive technology; screen readers hear "New",
"Dropped", or "Unchanged" before the line instead (localized).

## Import

```tsx
import { ChangeList } from "@k2b/ui";
```

## API reference

```ts
type ChangeTone = "add" | "change" | "remove" | "same" | "neutral" | "warning";
type ChangeMark = { label: string; icon?: string; tone?: "new" | "gone" | "neutral" };
type ChangeListItem = {
  tone: ChangeTone; icon?: string; content: JSX.Element; detail?: JSX.Element; marks?: readonly ChangeMark[];
};
type ChangeListProps = { items: readonly ChangeListItem[]; label: string; marker?: "icon" | "sign"; class?: string };
```

## Accessibility

The list carries `label` as its name. Tones are never the only signal: each line
says what happens in words.

## Runtime

`ChangeList` renders on the server and needs no browser code; it updates with its `items`.

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
