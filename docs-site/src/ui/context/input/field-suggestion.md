# Field suggestions

`TextInput`, `NumberInput`, `DatePicker`, `Select`, and `Switch` can show a
suggested value, such as one an assistant read from a document. The suggestion
is plain data. The field shows it and reports when someone accepts it. It never
fetches, saves, or submits anything, and it never becomes the value on its own.

Fields show suggestions only inside a `SuggestionGroup`. The group brings the
suggestion code and puts its fields under one line with counts and **Accept
all**, so forms without suggestions load none of it. Outside a group a field
ignores `suggestion` and warns once in the console.

## Use field suggestions

Use them when software proposes values for a form that a person checks, for
example the fields of an incoming invoice. The person stays the author: they
accept a value, type their own, or leave the field empty.

Never fill a field with a suggestion yourself, and never save or send an open
suggestion. Do not use a suggestion for a default value that the form owns.
Pass that default as `value` instead. Use `placeholder` for an example of the
format.

Markdown fields (`TextInput markdown`), a `plain` `DatePicker` in a property
row, `Combobox`, and `Checkbox` do not take suggestions yet.

## Import

```tsx
import { type FieldSuggestion, NumberInput, SuggestionGroup } from "@k2b/ui";
```

## The suggestion

Pass `suggestion` as a value or an accessor:

```ts
type FieldSuggestion<T> =
  | { id: string; state: "loading"; source?: string }
  | { id: string; state: "error"; source?: string; onRetry?: () => void }
  | {
      id: string; // stable per suggestion and source revision
      state: "ready";
      value: T;
      confidence: "high" | "low";
      reason?: string; // one sentence why it is unsure
      label?: string; // how the value reads, when the field cannot name it
      source?: string; // who proposes it, such as "Assistant"
      accepted?: boolean; // set by you once the value came from this suggestion
    };
```

`value` has the field's value type: a string for `TextInput` and `Select`, a
number for `NumberInput`, a date key such as `2026-10-28` for `DatePicker`,
and a boolean for `Switch`.

**Accept** calls `onSuggestionAccept(id)` and then the normal `onValueChange`
and `onValueCommit` with the suggested value. Set `accepted: true` on the
suggestion when you store that the value came from it. Store the suggestion
`id` with the value if you show its origin later.

## What the field shows

The field derives one state from its value and the suggestion:

- **Open:** the field is empty and nobody has edited it. The suggestion stands
  in the field as a placeholder in the AI colour, with an AI edge and fill. The
  status line says "Suggestion" and offers Accept. An unsure value has a
  warning edge and says "unsure". Its reason shows on hover, on focus of
  Accept, and in the field's description.
- **Own value:** the field holds something the person typed, or they emptied
  it on purpose. Their value stays. The status line says "Assistant: 312.40 €"
  and offers Accept.
- **Accepted:** the value equals the suggestion and `accepted` is true. The
  status line says "from Assistant".
- **Loading** and **error:** the status line says the source is reading, or
  that there is no suggestion, with Retry when you pass `onRetry`. An empty
  field shows a quiet bar while it loads.

A disabled or read-only field shows the suggestion dimmed, without Accept. A
`Switch` always has a position, so it shows its suggestion until someone flips
it. It keeps its real position, takes an AI ring, and names the suggested
position beside it. With a suggestion, its label moves above the switch.

Passing `suggestion` at all reserves the status line beside the label, even
while it resolves to `undefined`. Nothing moves when a suggestion arrives, is
accepted, is overruled, or goes away. A field without a visible label shows the
status line under the control.

## Groups

`SuggestionGroup` takes `title` (the line above the fields), `source` (used by
fields without their own), `onAcceptAll(ids)`, and optional `onRetryAll`. Its
fields register themselves, also during server rendering, so the counts are
right in the first render. A form with a single suggested field still uses a
group.

**Accept all** takes only open suggestions with `confidence: "high"` in fields
that are enabled, editable, and valid. It calls `onAcceptAll` once with their
ids. Apply them as one form change. Unsure values, own values, and locked
fields stay as they are.

## Accessibility

The field's value is announced as it is, so an open suggestion leaves the field
empty. The control's description adds "Suggestion from Assistant, not
accepted". Buttons and switches also name the suggested value. Accept is a
normal button named "Accept suggestion for <label>". After it, focus moves into
the field and a polite announcement says what was accepted. A new suggestion
for a field with the person's own value is announced once, and the value stays.
Accept all announces how many values it took and which unsure values remain
open. The group's title is a polite live region, and the group is `aria-busy`
while a field loads.

## Runtime

Server rendering shows every state, the reserved lines, and the group counts.
The first browser render matches it. Accepting and editing need browser code.

## Example

```tsx
const [amount, setAmount] = createSignal<number | null>(null);
const [accepted, setAccepted] = createSignal(false);

<SuggestionGroup
  source="Assistant"
  title="Assistant read the amount from INV-4471.pdf"
  onAcceptAll={() => {
    setAmount(312.4);
    setAccepted(true);
  }}
>
  <NumberInput
    label="Gross amount"
    step={0.01}
    suffix="€"
    value={amount}
    onValueChange={setAmount}
    suggestion={() => ({
      id: "inv-4471:v1:gross",
      state: "ready",
      value: 312.4,
      confidence: "high",
      accepted: accepted(),
    })}
    onSuggestionAccept={() => setAccepted(true)}
  />
</SuggestionGroup>;
```
