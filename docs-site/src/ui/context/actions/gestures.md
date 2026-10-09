# GestureMenu

`GestureMenu` gives an element touch gestures that are shortcuts into its
menu: swipe sideways, double-tap, and long-press. Every gesture runs an entry
of that menu, so the same action is always reachable without the gesture.

| Input | Result |
| --- | --- |
| Swipe right or left (touch, pen) | Runs the item with `gesture: "swipe-right"` or `"swipe-left"` |
| Double tap (touch, pen), double-click (mouse) | Runs the item with `gesture: "double-tap"` |
| Long press (touch, pen) | Opens the whole menu as a [`BottomSheet`](../layout/bottom-sheet) |
| Right-click, Context Menu key, Shift+F10 | Opens the menu beside the element, as [`ContextMenu`](../actions/menus) does |

A chat uses it on each message: swipe right to reply, double-tap to react with
👍, long press for reactions and every other action. A list of records can
swipe left to archive.

## Import

```tsx
import { GestureMenu, type GestureMenuItem } from "@k2b/ui";
```

## Use GestureMenu

Wrap the element and pass its menu as `items`, the same model as
[`Dropdown` and `ContextMenu`](../actions/menus). Give an action item a `gesture` to
let that gesture run it. Each gesture belongs to at most one item; a disabled
item also disables its gesture. `label` names the element and its menu, for
example "Message from Nora, 10:42".

`sheetTop` renders above the menu in the long-press sheet, for example a row
of quick reactions; its `close` closes the sheet. It appears only in the
sheet, not in the menu that a right-click opens.

`tabIndex` sets the element's place in the tab order, as for `ContextMenu`. A
list that moves focus between its rows itself, such as a conversation, passes
`-1`. Without items, the element has no gestures and no menu.

## Behavior

**Swipe.** The content follows the finger sideways; past 64 px a release runs
the action. Behind the content, the item's icon fills in as the swipe nears
that point. A swipe that is let go earlier snaps back and runs nothing. A
swipe starts only when the finger moves at least one and a half times as far
sideways as up or down, so a scrolling thumb never swipes; the browser keeps
vertical scrolling and pinch zoom. Swipes do not start within 20 px of the
screen's side edges, where the system's back gesture is.

**Double tap.** Two taps within 300 ms and 32 px of each other. The page does
not zoom on a double tap inside the element. With a mouse, a double-click
runs the same action instead of selecting a word; dragging still selects
text.

**Long press.** Holding a finger still for 500 ms opens the sheet with the
menu at touch size. Moving the finger first, or lifting it, cancels. The touch
that opened the sheet never presses anything in it.

**Where gestures do not start.** Links, buttons, fields, and other controls,
code blocks (`pre`), and anything marked `data-gesture-ignore` keep their own
behavior: a link opens, a code block scrolls sideways, and a right-click on a
link shows the browser's menu. `MessageRow` marks its code blocks, link
previews, and cards this way. Mark your own cards or interactive regions the
same way.

**Text selection.** On devices whose only pointer is touch, the element does
not select text, so a long press opens the menu instead of the browser's
selection and callout. Code blocks and marked regions stay selectable. Offer
an item such as "Select text" or "Copy text" when people need the text.

## Motion

The content moves only while a swipe runs, with a transform, so nothing
around it moves and the layout does not shift. With
`prefers-reduced-motion: reduce`, the content stays in place during a swipe;
the icon still fills in and the release still runs the action. The sheet's
entrance follows the `BottomSheet` rules.

## Accessibility

The element is a named group with `aria-haspopup="menu"`. The Context Menu
key and Shift+F10 open its menu, so every gesture has a keyboard and screen
reader equivalent. In the long-press sheet, the arrow keys, Home, and End move
through the items for a connected keyboard. The sheet is named with `label`;
the phone's Back closes it.

Gestures are shortcuts. Keep the important actions visible as well, for
example in the hover toolbar of `MessageRow`.

## API reference

```ts
type GestureKind = "swipe-right" | "swipe-left" | "double-tap";

type GestureMenuAction = DropdownActionBase & { action: () => void; gesture?: GestureKind };

type GestureMenuSection = Omit<DropdownSection, "items"> & {
  items: readonly (GestureMenuAction | DropdownAction | DropdownChoice)[];
};

type GestureMenuItem = GestureMenuAction | DropdownAction | DropdownChoice | GestureMenuSection;

type GestureMenuProps = {
  items: readonly GestureMenuItem[];
  label: string;
  children: JSX.Element;
  sheetTop?: (close: () => void) => JSX.Element;
  tabIndex?: number;
  class?: string;
};
```

`class` goes on the outer element.

## Runtime

Gestures need hydrated browser code; the server renders the element and its
menu semantics. The sheet opens through the shared `dialogCore`, so only one
modal stack exists.

## Example

A message in a conversation: swipe right to reply, double-tap to react, long
press for quick reactions and every other action.

```tsx
const items: GestureMenuItem[] = [
  { label: "Reply", icon: "ti ti-arrow-back-up", action: reply, gesture: "swipe-right" },
  { label: "React with 👍", icon: "ti ti-thumb-up", action: () => toggleReaction("👍"), gesture: "double-tap" },
  { label: "Copy text", icon: "ti ti-copy", action: copyText },
  { label: "Select text", icon: "ti ti-text-recognition", action: openTextSheet },
];

<GestureMenu
  label={`Message from ${author}, ${time}`}
  items={items}
  tabIndex={-1}
  sheetTop={(close) => <QuickReactions onPick={(emoji) => { react(emoji); close(); }} />}
>
  <MessageRow author={nora} text={text} time={time} />
</GestureMenu>;
```
