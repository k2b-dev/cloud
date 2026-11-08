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
| `font` | `"mono" \| "sans"` | `"mono"` | The font of the text, its highlighting, and the placeholder. `mono` suits Markdown source, such as a document; `sans` suits a message composer whose text later shows in the interface font. |
| `fill` | `boolean` | `false` | Fills the available parent height instead of using `lines`. |

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

`SlashCommands` adds commands behind `/` to an editor. Place it beside the editor and pass the editor's textarea from
`textareaRef`; it takes the same entries as [CommandMenu](/en/ui/actions/command-menu): commands that get the
composer's text, text snippets, and further lists such as people or tags, as a list or as a function of the context,
such as templates only when the slash starts the text. Editors without it carry none of its code.

```tsx
const [textarea, setTextarea] = createSignal<HTMLTextAreaElement>();
const [composer, setComposer] = createSignal<HTMLDivElement>();

<div ref={setComposer} class="composer">
  <MarkdownEditor variant="embedded" noToolbar font="sans" value={text()} onValueChange={setText} textareaRef={setTextarea} />
  <SlashCommands textarea={textarea()} items={commands} composer={composer()} />
</div>
```

Typing `/` at the start of a line or after a space opens the entries docked above the composer, exactly as wide as
it; near the top of the window they dock below it. The typed word filters them by label, description, hint, and
keywords, without regard to case or accents. A `/` inside a word or after punctuation, as in `and/or` or
`https://`, opens nothing.

- An entry with `onSelect` removes the typed `/query` from the text, then runs with the context: the query, the text
  without the `/query`, the text before the slash, whether it stands at the start of the text or a line, the path of
  entries chosen so far, `insert(text)` at the caret as typing would, `success(message)` and `error(message)`, and an
  abort `signal`. A returned promise keeps the list open with the entry busy. What the command reports, or a rejection
  with Retry, takes the list's place as a short green or red line. See
  [Context](/en/ui/actions/command-menu#context) and [Outcomes](/en/ui/actions/command-menu#outcomes).
- An entry with `text` puts its text in place of `/query`.
- An entry with `next` opens its list in the same place: the typed `/query` leaves the text, the list gets its own
  search field, and the focus moves there. Typing filters the list, the first match is marked, and <kbd>Enter</kbd>
  chooses it: `/zuw` <kbd>Enter</kbd> `val` <kbd>Enter</kbd> assigns Valentin and puts the caret back where the slash
  stood. <kbd>Esc</kbd>, or <kbd>Backspace</kbd> in the empty field, goes back; back in the first list, the `/query`
  returns. While entries load, <kbd>Enter</kbd> waits for that query and takes its first match.
- <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Home</kbd> <kbd>End</kbd> mark the entries that can be chosen while the list is open,
  <kbd>Enter</kbd> and <kbd>Tab</kbd> choose, and <kbd>Esc</kbd> stops a running command or, in the first list,
  closes it and keeps the text. It stays closed until the next `/`.
- A word without matches closes the list, so <kbd>Enter</kbd> starts a new line as usual.

The editor leaves a key to `SlashCommands` when it marked it handled with `preventDefault`. The list floats in the
top layer, so it never moves the composer or the text. `SlashCommands` and `completions` work side by side; give `/`
to only one of them.

## Editing behavior

The editor keeps a native textarea as the input surface. A synchronized presentation layer provides markdown highlighting without replacing browser selection, composition, or undo behavior.

Both layers and the placeholder read one font from the editor's root, with the same size, line height, letter
spacing, and tab size, so the caret and the selection stay on the highlighted text in either `font`. For the same
reason, inline code and code blocks inside the editor use the editor's font; they stand out by their marks and
highlighting, not by a font of their own.

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
