# Dictation

Live dictation puts spoken words into a field while the person speaks. The
library owns the microphone button, the bar that stands in for the field's
controls, and every notice. The application passes a `DictationSource`, which
turns speech into text, and a `DictationTarget`, which places the text.
`ChatComposer` has its own target: pass `dictation={{ source }}`.

## Use dictation

- Put `DictationButton` at a fixed place among the field's controls. A press
  starts dictation; a second press or Stop ends it.
- While `dictationBarShown(dictation)` is true, render `DictationBar` instead
  of the controls in the same row, at the same height. It shows Discard, the
  level, the time, the microphone and Stop. Nothing else in the row moves.
- After Stop the bar shows "Finishing …" until the last words arrive. The text
  stays where it is.
- Discard removes only the dictated words. Text that was there before stays,
  and so does text the person typed outside the dictated words.
- The person can type anywhere while dictating. New words land at the
  dictation mark, which moves along with edits before it.
- Undo groups dictated words like typing. Words that Undo removed and Redo
  brought back count as typed text, so Discard leaves them.
- Another draft, a field that turns read-only, or a host that drops the source
  ends dictation at once; the words so far stay.
- From one minute before the maximum the time counts down. At the end the bar
  says so and offers "Continue dictating" at the same mark.

## States

| State | What shows | Way out |
| --- | --- | --- |
| Microphone blocked | Card with how to allow it | Try again |
| Interrupted | Bar notice, the text stays | Continue dictating |
| Offline | Microphone greyed out, focusable, with a hint | Returns by itself |
| Allowance used up | Card with the time it resets | OK |
| Busy | Card; `alternative` adds a second way, such as recording | Try again |
| Another tab dictates | Card | OK |
| Maximum reached | Bar notice, the text stays | Continue dictating |

Cards open above the microphone (or `cardAnchor`) and stay inside the screen,
also on a phone. Their buttons wrap instead of running out of the card.

## Source contract

`source.start({ deviceId, signal })` returns `{ events, stop }`. Events are
`state` (`connecting`, `live` with `maxMs` and `device`, `finishing`,
`finished` with an optional `reason`), `level` (0 to 1), `text` (new words to
append, never revised) and `error` (`code`, `retryable`, `resetsAt`). Aborting
`signal` ends the session at once. `stop()` resolves after the last words.
`source.devices()` lists microphones; the choice is kept in `localStorage`.

## Accessibility

The microphone is a toggle (`aria-pressed`). Starting moves focus to Stop;
the end returns it to the microphone, or to "Continue dictating" after a bar
notice. State changes are announced politely; the dictated words are not read
aloud. Escape closes an open microphone list first, otherwise it stops.

## Runtime

The microphone, the bar and the cards need browser code. The server renders the
microphone at its place; nothing else shows until a person presses it. The
microphone list loads when it opens, and the choice is kept in `localStorage`.

## Import

```tsx
import { createDictation, DictationBar, DictationButton, dictationBarShown } from "@k2b/ui";
```

## Example

```tsx
const dictation = createDictation({ source, target });

<Show when={dictationBarShown(dictation)} fallback={<Controls end={<DictationButton dictation={dictation} />} />}>
  <DictationBar dictation={dictation} />
</Show>
```
