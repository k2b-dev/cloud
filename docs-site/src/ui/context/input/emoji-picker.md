# EmojiPicker

`EmojiPicker` lets people choose an emoji: by searching in English or German,
from the emoji they used recently, or by browsing the groups. People who have
skin tones choose one once. The keyboard reaches everything.
`EmojiPicker.Popover` opens the picker next to a control, such as the emoji
button of a [`Chat.Composer`](/en/ui/ai/chat) or "Add reaction" in a
[`MessageRow`](/en/ui/content/message-rows).

## Import

```tsx
import { EmojiPicker, type EmojiSkinTone, rememberEmoji } from "@k2b/ui";
```

## Use EmojiPicker

The application keeps the anchor, the recent emoji, and the skin tone. The
picker reports each choice and asks to close:

```tsx
const [anchor, setAnchor] = createSignal<HTMLElement>();
const [recent, setRecent] = createSignal<readonly string[]>(preferences.recentEmoji);
const [tone, setTone] = createSignal<EmojiSkinTone>(preferences.skinTone);

<MessageRow {...row} onAddReaction={setAnchor} />
<EmojiPicker.Popover
  anchor={anchor()}
  recent={recent()}
  skinTone={tone()}
  onSkinToneChange={(next) => {
    setTone(next);
    savePreference("skinTone", next);
  }}
  onPick={(emoji) => {
    react(message, emoji);
    setRecent(rememberEmoji(recent(), emoji));
    savePreference("recentEmoji", recent());
  }}
  onClose={() => setAnchor(undefined)}
/>
```

- The picker is open while `anchor` is set. It opens above the anchor where
  there is room and below it otherwise, aligned with the anchor's end, and
  stays inside the visible part of the viewport. When a phone's keyboard
  covers part of the page, the picker moves into the rest, and its grid gets
  shorter where the rest is lower than the picker.
- It closes after a pick, on Escape in an empty search field, on a click
  outside, and on a second press of its anchor, with a pointer or a key. Each
  time `onClose` asks the application to clear `anchor`.
- Focus moves into the search field when it opens, except on touch-only
  devices, where the keyboard would cover the emoji. When it closes, focus
  returns to where it was, unless `onPick` moved it on purpose, as the
  composer's `insert` does.

The inline `EmojiPicker` takes the same props without `anchor`, plus
`onClose` (Escape in an empty search field) and `autofocus`. Use it inside a
surface the application already owns, such as a
[`BottomSheet`](/en/ui/layout/bottom-sheet) for reactions on a phone.

## Recent emoji and skin tones

- `recent` lists emoji most recent first and shows them as the first group,
  three rows at most. `rememberEmoji(recent, emoji)` returns the next list:
  the emoji first, once, and the oldest dropped. The application stores the
  list, for example in the person's settings, so it follows them across
  devices.
- `skinTone` is `0` for the default yellow or `1` (light) to `5` (dark).
  Emoji with skin tones show and are picked in that tone; recent emoji keep the
  tone they were picked in. `onSkinToneChange` adds the tone choice to the
  header; without it the picker has none.

## Search

The search matches English and German names and keywords and GitHub
shortcodes, so "Daumen", "thumbs up", and "+1" all find 👍. It ignores case and
accents and accepts "ae" for "ä". Names show in the render language: German
for a `de` locale, English otherwise.

## Accessibility

The keyboard reaches everything, and the focus stays in the search field:

- the arrow keys move through the grid in rows of eight, from one group into
  the next; Left and Right move the caret of a search until Up or Down enters
  the grid;
- Enter picks the highlighted emoji, which is the best match while searching;
- Escape clears the search, and closes the picker when the search is empty;
- Tab reaches the skin-tone button, whose arrow keys choose a tone, and the
  group bar, whose arrow keys move between groups.

Screen readers hear the field as a combobox and each emoji by its name, in
groups named after the emoji group. Group buttons and skin tones have names
and tooltips; the current group is marked with `aria-current`.

## Layout

Every part has a fixed height: the search field, the group bar, the grid, and
the name line under it. Searching, hovering, choosing a tone, and finding
nothing change only paint. On a coarse pointer, cells and controls are
2.75rem, and the picker stays narrower than a 390px phone.

## Runtime

Search, keyboard use, and the popover need hydrated Solid client code; on the
server the picker renders its frame with the loading state.

The emoji names come from [Emojibase](https://emojibase.dev) (MIT), up to
Emoji 15.1, the newest version that current Apple, Android, Windows 11, and
Noto fonts all draw. The data is about 80 kB compressed and loads with the
first picker or the first colon typed in a composer with `emoji`, as a chunk
of its own: a page that never uses either does not grow by it. Until it has loaded, the grid shows a
spinner in its place; if it cannot load, the picker says so and offers
"Retry".

## Shortcodes in the composer

`Chat.Composer` completes `:shortcodes` from the same data whenever it has an
`emoji` prop. Unlike the search, it matches only the start of a shortcode,
name, or keyword, so emoticons such as `:DD` stay text. See [Formatting,
emoji, and microphone](/en/ui/ai/chat#formatting-emoji-and-microphone).

## Example

On a phone, the picker fits a [`BottomSheet`](/en/ui/layout/bottom-sheet):

```tsx
import { BottomSheet, bottomSheetOptions, dialogCore, EmojiPicker, rememberEmoji } from "@k2b/ui";

const emoji = await dialogCore.open<string>((close, context) => (
  <BottomSheet onDismiss={context.requestDismiss}>
    <BottomSheet.Header title="React" close={context.requestDismiss} />
    <BottomSheet.Body>
      <EmojiPicker recent={recent()} skinTone={tone()} onSkinToneChange={setTone} onPick={close} />
    </BottomSheet.Body>
  </BottomSheet>
), bottomSheetOptions);
if (emoji) {
  react(message, emoji);
  setRecent(rememberEmoji(recent(), emoji));
}
```
