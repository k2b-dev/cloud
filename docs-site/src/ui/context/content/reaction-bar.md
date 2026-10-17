# ReactionBar

`ReactionBar` shows emoji reactions with their counts in chat rows, item
comments and details, or cards. Use a toggle button for a single like action;
use this bar when several emoji share the same reaction model.

The application owns the reactions, their order and stable keys, pending
intents, and the picker. The bar owns layout, the names hint, and gestures.
It has no dependency on Cloud or an application's data.

## Import

```tsx
import { ReactionBar, reactionPeople, type ReactionBarItem, type ReactionBarProps, type ReactionPeopleInput } from "@k2b/ui";
```

## Use ReactionBar

- `reactions` is an ordered list of `{ key, emoji, count, own?, label?, busy? }`.
  A chip keeps its element and focus for its `key` when new objects arrive.
  `own` highlights the reader's reaction. `busy` adds `aria-busy="true"`
  while an intent is saving; the application decides how to handle further
  presses and failures.
- `onToggle(key)` makes every chip a toggle button. Without it, chips are
  read-only images. `onAdd(anchor)` adds "Add reaction" and receives its
  button, ready to anchor `EmojiPicker.Popover`. Without it there is no button.
- `density="default"` gives 26 px chips for chat and item details;
  `density="compact"` gives 24 px chips for cards.
- `overflow="scroll"` is the default: one line of fixed height, chips that
  scroll sideways behind a fade, and a fixed add button. `overflow="wrap"`
  shows every chip and lets chips and the add button wrap together.
- `max` is a positive integer: show the first `max` emoji without scrolling,
  using the wrapping layout. Further emoji become "+n". It counts emoji,
  not people: five different emoji with `max={3}` show "+2". This is plain,
  pointer-transparent text, never a button or a tab stop, so a card's action
  beneath it still receives the pointer. `moreLabel(count)` replaces its
  screen-reader text, which defaults to "2 more reactions" or "2 weitere
  Reaktionen" in the inherited locale.
- `add="always"` is the default. With `add="progressive"`, put the bar inside
  a `k2b-progressive-row` ancestor: the add button shows on hover and focus
  with a mouse or trackpad, keeping its space while hidden, and is absent on
  touch. It stays visible while its picker is open because
  [`EmojiPicker.Popover`](/en/ui/input/emoji-picker) sets `aria-expanded` on
  the anchor. `class` adds a caller's class to the bar.

An empty scrolling bar keeps its height. Its scrolling list exists only
while there are chips. [`MessageRow`](/en/ui/content/message-rows) uses this
reserved space to keep chat rows still when reactions come and go.

## Name the people

Set `label` to the localized names of those who reacted. `reactionPeople`
helps build it from `names` (others in reaction order, excluding the reader),
`own`, and the total `count`. Pass the inherited locale from `useLocale()`;
the pure helper defaults to English.

The reader comes first as "You" or "Du". If everyone is known and the total
is at most three, all names show without an Oxford comma. Otherwise it shows
the first two known people, or fewer when fewer are known, then "and n more"
/ "und n weitere". The total is at least the number of supplied people.

```ts
reactionPeople({ names: ["Nora Brandt"], own: true, count: 2 });
// "You and Nora Brandt"
reactionPeople({ names: ["Nora Brandt", "Release-Bot"], own: true, count: 3 }, "de");
// "Du, Nora Brandt und Release-Bot"
reactionPeople({ names: ["Nora Brandt", "Tobias Wendt"], own: true, count: 5 });
// "You, Nora Brandt and 3 more"
reactionPeople({ names: ["Nora"], count: 3 });
// "Nora and 2 more"
```

## Inspect names

A chip with a non-empty `label` shows one shared names hint containing its
emoji and label. Hover or visible keyboard focus opens it after 250 ms;
moving directly between chips updates an open hint immediately. Leaving or
moving focus away closes it.

On touch or pen, hold a chip for 500 ms to open a larger hint without toggling.
Moving more than 8 px or cancelling the press abandons the hold and lets the
browser scroll. A short tap on a writable chip toggles as usual; a short tap
on a read-only chip opens its names hint. A touch hint survives pointer leave
and focus changes. The next pointer press, scrolling (including the chip
list), resize, or Escape closes it. A new tap on a writable chip closes an
open hint and can toggle normally.

## Accessibility

The bar is a group named "Reactions" ("Reaktionen" in German). Toggle chips
use `aria-pressed`; their accessible name includes emoji, count, and names.
Read-only chips use `role="img"`, also say whether the reader reacted, and
are not tab stops. A scrolling read-only list is one tab stop so the keyboard
can scroll it; a wrapping list adds no tab stop. The chip's visible focus
ring sits outside its edge with a 1 px offset.

The names hint is hidden from screen readers because the chip's accessible
name already includes those names. It does not replace that accessible name.
"+n" has separate localized screen-reader text.

## Runtime

Server and client render the same initial markup, including one closed hint
surface per bar. The hint and gestures need JavaScript; without it, the
chip's `aria-label` still carries the names. The bar reads its own messages
from the inherited English or German locale. The application supplies
localized labels, keeps reaction state, and handles pending intents and
failed saves.

## Example

The live demo keeps the reactions of one item in local state, as an
application would keep them per item, and renders four bars from it:

```tsx
import { createSignal } from "solid-js";
import { EmojiPicker, Paper, ReactionBar, reactionPeople, useLocale } from "@k2b/ui";

function useDemoReactions() {
  const locale = useLocale();
  const [entries, setEntries] = createSignal([
    { key: "👍", emoji: "👍", names: ["Nora Brandt", "Tobias Wendt", "Lea Sommer", "Jonas Peters"], own: true },
    { key: "🎉", emoji: "🎉", names: ["Nora Brandt", "Release-Bot"], own: false },
    { key: "❤️", emoji: "❤️", names: ["Lea Sommer"], own: false },
    { key: "👀", emoji: "👀", names: ["Tobias Wendt"], own: false },
    { key: "☕", emoji: "☕", names: ["Jonas Peters"], own: false },
  ]);
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const reactions = () =>
    entries().map((entry) => {
      const count = entry.names.length + Number(entry.own);
      return { key: entry.key, emoji: entry.emoji, own: entry.own, count, label: reactionPeople({ names: entry.names, own: entry.own, count }, locale()) };
    });
  const toggle = (key: string) =>
    setEntries((items) =>
      items.map((item) => (item.key === key ? { ...item, own: !item.own } : item)).filter((item) => item.own || item.names.length > 0),
    );
  // A pick adds the reader's reaction; one that is already theirs changes nothing.
  const pick = (emoji: string) => {
    if (entries().some((entry) => entry.key === emoji && entry.own)) return;
    if (entries().some((entry) => entry.key === emoji)) toggle(emoji);
    else setEntries((items) => [...items, { key: emoji, emoji, names: [], own: true }]);
  };
  return { reactions, toggle, pick, anchor, setAnchor };
}

// Chat and item detail
<ReactionBar reactions={item.reactions()} onToggle={item.toggle} onAdd={item.setAnchor} />
<EmojiPicker.Popover anchor={item.anchor()} onPick={item.pick} onClose={() => item.setAnchor(undefined)} />

// Card
<Paper class="k2b-progressive-row">
  <span>Plan the team offsite</span>
  <ReactionBar
    reactions={item.reactions()}
    onToggle={item.toggle}
    onAdd={item.setAnchor}
    density="compact"
    max={3}
    add="progressive"
    moreLabel={(count) => `${count} more reactions, shown in the item`}
  />
</Paper>

// Every reaction, wrapping
<ReactionBar reactions={item.reactions()} onToggle={item.toggle} onAdd={item.setAnchor} overflow="wrap" />

// Read-only
<ReactionBar reactions={item.reactions()} overflow="wrap" />
```
