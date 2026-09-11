# AutocompleteEditor

`AutocompleteEditor` is a controlled plain-text editor with synchronous or asynchronous completions. The parent owns the text and supplies the completion rules.

## Use AutocompleteEditor

Use it for mentions, formulas, query builders, commands, and other text where suggestions depend on the token at the caret.

Use `TextInput` for ordinary form text. Use `MarkdownEditor` when the document needs markdown editing and formatting behavior.

## Import

```tsx
import {
  AutocompleteEditor,
  type Completion,
  type SuggestContext,
  type Suggestion,
} from "@k2b/ui";
```

## Value and submission

Pass the current text directly or through a Solid accessor.
`onValueChange` receives every edit and `onValueCommit` receives committed
textarea changes.

Multiline mode is the default. In this mode, <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> calls `onSubmit`. With `singleLine`, bare Enter submits and newlines are disabled.

## Completions

Each `Completion` has an optional trigger and a `suggest` function. The
function receives `(query, context, signal)` and may return suggestions
immediately or as a promise. `context` contains the complete text, caret, and
token start. Use the signal to cancel remote work.

Set `dropdown: true` to show all matches. The dropdown aligns with the start of
the active token, follows editor scrolling, and stays within the viewport.
Without it, the active suggestion appears as a ghost preview. Tab accepts the
active suggestion; dropdowns also support arrow keys and Enter.

Use `debounceMs` for remote lookups. A new query aborts the previous request. `allowAfterWord` permits triggers such as `(` directly after a function name.

Use `knownLabels` only for a fixed set of tokens that a Markdown overlay may
highlight. It is metadata: the editor never calls `suggest` merely to discover
labels, so asynchronous providers stay free of mount-time requests.

`highlight` may return safe HTML for an overlay preview. Keep token styling width-neutral: color and background are safe; font weight, style, and letter spacing can desynchronize the overlay from the textarea.

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for `FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`.

```ts
type Suggestion = {
  text: string; label?: string; expansion?: string; appendSpace?: boolean; hint?: string;
  textEdit?: {
    start: number;
    end: number;
    text: string;
  };
};

type SuggestContext = {
  fullText: string; caret: number; tokenStart: number;
};

type QueryContext = {
  start: number; end: number; text: string; query: string; completion: Completion;
};

type Completion = {
  trigger?: string;
  suggest: (query: string, context: SuggestContext, signal: AbortSignal) => readonly Suggestion[] | Promise<readonly Suggestion[]>;
  knownLabels?: readonly string[]; debounceMs?: number; dropdown?: boolean; allowAfterWord?: boolean;
};

type AutocompleteEditorProps = ValueFieldProps<string> & {
  onSubmit?: () => void; completions?: readonly Completion[]; restoreExpansionOnBackspace?: boolean;
  highlight?: (text: string) => string; singleLine?: boolean; lines?: number; fill?: boolean;
  placeholder?: string; spellcheck?: boolean; name?: string; maxLength?: number;
  textareaRef?: (element: HTMLTextAreaElement) => void; variant?: "default" | "paper";
};
```

`text` is the inserted token. `label` is its displayed name; `expansion` supplies expanded content. `textEdit` replaces the explicit zero-based `[start, end)` character range instead of the detected token. `appendSpace` controls a trailing space (default true; an existing separator or opening scope avoids a second separator). `knownLabels` marks known tokens; `allowAfterWord` permits a trigger immediately after a word character.

Defaults: `lines=3`, `singleLine=false`, `fill=false`, `spellcheck=false`, `variant="default"`, `restoreExpansionOnBackspace=true`. Disable the last option to keep Backspace from restoring an expansion to its trigger. Completion `debounceMs` defaults to 0; `dropdown` is opt-in. `textareaRef` receives the mounted native textarea. `highlight` returns trusted HTML: escape source text and preserve text positions.

`abbreviations` is a public map used by [MarkdownEditor](/en/ui/input/markdown-editor); its custom map is `Record<string, string>` from abbreviation to expansion.

## Accessibility

Prefer `label`, `description`, `error`, and `required` for field semantics. If
the surrounding UI supplies the label instead, pass `"aria-label"` and
`"aria-describedby"` using their native hyphenated names.

The textarea exposes combobox, listbox ownership, active-descendant, and
expanded state semantics. The popup uses selected options, a loading status,
and an alert with retry for failed asynchronous work. Suggestion labels and
hints must make sense without color alone.

## Runtime

The editor requires hydrated Solid client code. Completion resolution, cancellation, caret positioning, keyboard navigation, and the optional overlay depend on browser APIs.

## Example

```tsx
const users = ["alice", "bob", "charlie"];
const [message, setMessage] = createSignal("");

const mentions: Completion = {
  trigger: "@",
  dropdown: true,
  knownLabels: users.map((user) => `@${user}`),
  suggest: (query) =>
    users
      .filter((user) => user.startsWith(query.toLowerCase()))
      .map((user) => ({
        text: `@${user}`,
        label: user,
        hint: "user",
      })),
};

<AutocompleteEditor
  label="Message"
  description="Type @ to mention someone."
  value={message()}
  onValueChange={setMessage}
  lines={4}
  completions={[mentions]}
/>;
```
