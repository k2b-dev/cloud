# MarkdownEditor

`MarkdownEditor` is a standalone controlled editor for Markdown content. It owns editing behavior and visual highlighting. The parent owns the document value, validation, persistence, and submission flow.

## Use MarkdownEditor

Use it for composers, notes, document bodies, and other editing surfaces that do not need `TextInput` form chrome.

Use `TextInput` with markdown mode when the editor belongs to a labeled form field with help text and validation messaging.

## Import

```tsx
import {
  MarkdownEditor,
  type MarkdownEditorProps,
} from "@k2b/ui";
```

## Value and events

Pass the current string directly or through a Solid accessor.
`onValueChange` runs after every edit and `onValueCommit` runs when the
underlying textarea commits its change, normally on blur. `onSubmit` runs only
for <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd>. Bare Enter always inserts
or continues a line.

## Core properties

| Property | Type | Default | Purpose |
| --- | --- | --- | --- |
| `value` | `string \| null \| Accessor<string \| null>` | empty | Supplies the current document. |
| `onValueChange` | `(value: string) => void` | none | Receives every edit. |
| `onValueCommit` | `(value: string) => void` | none | Receives committed textarea changes. |
| `onSubmit` | `() => void` | none | Handles Ctrl/Cmd+Enter. |
| `placeholder` | `string` | none | Labels an empty editor visually. |
| `disabled` | `boolean` | `false` | Disables editing and toolbar actions. |
| `lines` | `number` | `6` | Sets the approximate visible height. |
| `maxLength` | `number` | none | Applies the native textarea limit. |
| `spellcheck` | `boolean` | `true` | Controls browser spellcheck. |
| `noToolbar` | `boolean` | `false` | Hides the toolbar without disabling shortcuts. |
| `showStats` | `boolean` | `true` | Shows line, word, and character counts. Suppressed entirely while `disabled`. |
| `variant` | `"default" \| "paper" \| "embedded"` | `"default"` | Matches the editor surface to its parent. `embedded` removes the outer border, radius, and shadow for an existing workspace surface. |
| `fill` | `boolean` | `false` | Fills the available parent height instead of using `lines`. |
| `commands` | `CommandItem[] \| (query) => CommandItem[]` | none | Opens [slash commands](#slash-commands) on `/`. |

Native form and accessibility properties include `name`, `id`, `"aria-label"`,
`"aria-describedby"`, `required`, plus the shared `label`, `description`, and
`error` field state.

## Save controls

Pass `onSave` to add a save action and enable <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>S</kbd>.

`saveDisabled` and `saving` are direct booleans. `toolbarTrailing` adds related
controls beside the save action.

`onClose?: () => void` adds an X button and groups Save and Close at the end
of the toolbar after formatting. `toolbarTrailing` precedes these actions. Closing remains available in a read-only editor.
The caller owns navigation, pending-save handling, and confirmation of unsaved
changes. Combine `fill`, `variant="embedded"`, and `onClose` for a document
workspace without a separate application toolbar.

`saved?: boolean` replaces the save icon with a check after confirmed persistence.
The caller resets it after a brief delay or the next edit; clicking Save alone
must not report success. `saving` takes precedence.

Persistence remains outside the component. Debounce or queue writes in the owning application.

## Completions

`abbreviations` provides fixed short-to-long expansions. `completions` supports synchronous or asynchronous suggestions, optional trigger characters, dropdown suggestions, and ghost previews.

When both are present, abbreviations run first and the explicit completion definitions are appended.

Static completion tokens can opt into Markdown highlighting through
`knownLabels`. Keep remote results inside `suggest`; metadata collection never
executes a completion provider.

Tab accepts the active suggestion. Dropdown completions add arrow-key
navigation, Enter acceptance, Escape dismissal, and retryable loading and error
states. A new query aborts stale asynchronous work. Completions do not expand
inside inline code or fenced code blocks.

## Slash commands

`commands` takes the same `CommandItem[]` as [CommandMenu](/en/ui/actions/command-menu): actions, text snippets, and
second lists such as people or tags. Typing `/` at the start of a line or after a space opens them at the slash; the
typed word filters them by label, hint, and keywords, without regard to case or accents. A `/` inside a word, as in
`and/or`, opens nothing.

- An entry with `onSelect` removes the typed `/query` from the text, then runs.
- An entry with `text` puts its text in place of `/query`.
- An entry with `next` opens its list in the same popover; the typed word gives way to a bare `/`, and typing filters
  the second list. <kbd>Esc</kbd>, or <kbd>Backspace</kbd> after the bare `/`, goes back.
- <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Home</kbd> <kbd>End</kbd> mark entries while the list is open, <kbd>Enter</kbd> and
  <kbd>Tab</kbd> choose, and <kbd>Esc</kbd> in the first list closes it and keeps the text. It stays closed until
  the next `/`.
- A word without matches closes the list, so <kbd>Enter</kbd> starts a new line as usual.

The list hangs at the slash and keeps a fixed width, so typing and second lists move neither the list nor the editor.
`commands` and `completions` work side by side; give `/` to only one of them.

## Editing behavior

The editor keeps a native textarea as the input surface. A synchronized presentation layer provides markdown highlighting without replacing browser selection, composition, or undo behavior.

The toolbar covers bold, italic, inline code, links, three heading levels,
bulleted and numbered lists, and quotes. It includes matching keyboard
shortcuts, list continuation and exit, smart URL paste, IME-safe input, active
format detection, synchronized scrolling, and optional line, word, and
character statistics.

`textareaRef?: (element: HTMLTextAreaElement) => void` exposes the mounted native
textarea. `completions` uses the [Completion/Suggestion contract](/en/ui/input/autocomplete#api-reference).
The editor inherits [ValueFieldProps<string>](/en/ui/getting-started#shared-field-props);
`lines` defaults to 6 and `spellcheck` and `showStats` default to true.

## Accessibility

Prefer `label`, `description`, and `error`. When surrounding UI already
provides the field chrome, use `"aria-label"` and `"aria-describedby"` with
their native hyphenated names.

The toolbar uses one tab stop plus Left, Right, Home, and End navigation.
Formatting buttons expose active state through `aria-pressed`. The textarea
uses combobox semantics when completions are configured; an open dropdown is a
linked listbox with an active descendant and selected options. Slash commands use
the same pattern: their groups are labeled by their headings, and an unavailable
entry is `aria-disabled` with its reason in its name. Loading uses a
status, failures use an alert, and the presentation layer is hidden from
assistive technology.

## Runtime

`MarkdownEditor` is interactive and requires browser code. The surrounding page can remain server rendered.

## Example

```tsx
const [body, setBody] = createSignal("");

<MarkdownEditor
  label="Note"
  value={body()}
  onValueChange={setBody}
  lines={10}
  placeholder="Write a note…"
/>;
```
