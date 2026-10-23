# TextInput

`TextInput` is the standard labeled text field for portable application forms.
The parent owns the value, validation, persistence, and form submission.

## Use TextInput

Use it for short text, search terms, email addresses, URLs, telephone numbers, passwords, and small multiline fields.

Use `MarkdownEditor` for a standalone document editor. Use `AutocompleteEditor` when completion behavior is the main interaction rather than ordinary form input.

## Import

```tsx
import { TextInput } from "@k2b/ui";
```

## Value and events

Pass `value` directly or as a Solid accessor. `onValueChange` receives every
edit. `onValueCommit` receives the committed string, normally when the field
loses focus.

`onKeyDown` reaches native inputs and plain textareas before the built-in Enter
submission. Call `event.preventDefault()` to handle Enter yourself without also
calling `onSubmit`. Escape and arrow keys remain available to the caller.

`clearable` adds a clear button to a single-line field. Without `onClear`,
clearing emits an empty string through both value callbacks.

## Input modes

- `type` supports text, search, email, URL, and telephone input.
- `multiline` renders a plain textarea. Its initial value, including leading newlines, is readable before hydration.
- `markdown` renders the shared `MarkdownEditor` and implies multiline input.
- `password` adds a show or hide control.
- `variant="ai"` changes the field treatment and default icon. It does not add AI behavior.
- Without `icon`, the field shows a text-cursor icon that turns into a pencil while focused. A custom `icon` stays while focused unless `activeIcon` sets a different one.
- `icon={false}` omits the leading icon while retaining the standard field size.
- `monospace`, `prefix`, and `suffix` adapt the field to code-like values and short units.

Enter calls `onSubmit` in single-line fields and in plain multiline mode, where Shift+Enter inserts a newline. In markdown mode, <kbd>Ctrl</kbd>/<kbd>Cmd</kbd> + <kbd>Enter</kbd> calls `onSubmit`; bare Enter stays available for writing.

## Field state

`label`, `description`, `required`, and `error` form one field. `disabled`
disables the input and its controls.

The complete visible input shell keeps the text cursor across leading icons,
affixes, and padding. Prefixes and suffixes keep space from the field edges,
including when no clear or password control is present. Clear and password
controls retain their action cursor.

`spellcheck` and `maxLength` pass through in every mode, including markdown. `autocomplete` and `autocapitalize` reach the native input and textarea only, not the markdown editor. `inputMode` applies to the single-line input.

Browser autofill remains enabled for native single-line inputs. While the
browser reports an autofilled value, `TextInput` extends one semantic surface
across the input, leading icon, affixes, and clear or password control. Editing
the value returns the field to its regular visual state.

## Compact inline values

Use `variant="compact"` for a single-line value in a dense editor or tool row.
It renders a 26 px shell without an icon container; `icon` and `activeIcon` do
not apply. Compose a visible value name with `prefix` and provide `aria-label`
when no field label is rendered. The native `size` sets the value width
(default 9 characters). Long values scroll within the input.

The compact variant uses 12 px text with a fine primary pointer and at least
16 px on a coarse pointer. Its 20 px text line and 26 px shell keep their
height; the larger touch font makes each character wider. Do not shrink or
scale touch text to reproduce a smaller mockup font.

`error` retains the visible error message and its accessible association, just as
in the default variant. A compact field must not hide a diagnostic to fit a row.
Compact mode is intended for ordinary single-line values, not password,
multiline, or Markdown editing.

```tsx
<TextInput
  variant="compact"
  monospace
  prefix={<span>:region</span>}
  aria-label="Region"
  size={9}
  value={region}
  onValueChange={setRegion}
/>
```

## Place a native field error elsewhere

Use `externalErrorId` only when your composition renders the complete matching
error outside the field. It applies to native inputs and plain textareas in
any variant. Markdown mode keeps its regular inline error.

Keep passing `error`: it controls the invalid state and error outline. With an
active error and a valid `externalErrorId`, the input describes that target
instead of rendering a local error paragraph. Existing labels and descriptions
remain connected. Without an error, the target ID is not added to the input.
Without a valid ID, the ordinary visible inline error remains, including in
compact mode.

The ID must be nonempty and contain no ASCII whitespace; numbers and
punctuation are allowed. The library checks this syntax only. Your component
must render a unique target in the same document, keep it visible while the
error is active, and provide the complete matching error text. A hidden,
missing, or unrelated target loses the useful diagnosis. Keep both the field's
`error` and the target text derived from the same validation state.

Your component also owns the necessary error announcement. External mode
creates neither a local error message nor a live region. Use your existing
status live region, or provide an appropriate announcement in your
composition; avoid announcing the same error twice. The visible target must
already exist in server HTML when the server renders an active error.

```tsx
const errorId = createUniqueId();
const error = () => region() ? undefined : "Enter a region before continuing.";

<>
  <TextInput
    variant="compact"
    aria-label="Region"
    prefix=":region"
    value={region}
    onValueChange={setRegion}
    error={error}
    externalErrorId={errorId}
  />
  <p id={errorId} role="status">{error()}</p>
</>;
```

Changing the target ID, returning to an inline error, or correcting the value
updates the association without replacing the native input. Do not also add
the error ID unconditionally through `aria-describedby`.

## Touch devices

On a device whose primary pointer is coarse, such as a phone, the editable text
of every `@k2b/ui` field renders at 16 px instead of the compact desktop size.
This covers `TextInput` in every mode, number, tag, PIN, and combobox fields,
the search fields inside selects and prompts, the time field of the date
pickers, the editors, and the chat composer. iOS Safari zooms the page when a
focused field uses smaller text and leaves it zoomed afterwards.

Only the text grows. The field, its label, and the surrounding layout keep
their size and position, and devices with a mouse or trackpad keep the compact
text. Do not set `maximum-scale` or `user-scalable=no` on the viewport to
prevent the zoom; that takes pinch zoom away from people who need it. Give a
field that an application builds itself at least 16 px of text on coarse
pointers for the same reason.

A single-line field for a user name, an address, or a password is typed
exactly. When `password` is set, `type` is `email` or `url`, or
`autocomplete` names `username`, `email`, or `url`, the input defaults to
`autocapitalize="none"`, `autocorrect="off"`, and `spellcheck={false}`, so
phone and tablet keyboards do not capitalize the first letter or replace the
word. An explicit prop wins over the default.

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for `FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`.

```ts
type TextInputProps = Omit<
  JSX.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "onInput" | "prefix" | "suffix" | "type" | "value" | keyof ValueFieldProps<string>
> &
  ValueFieldProps<string> & {
    minLength?: number;
    maxLength?: number;
    type?: "text" | "search" | "email" | "url" | "tel";
    variant?: "default" | "ai" | "compact";
    icon?: string;
    activeIcon?: string;
    externalErrorId?: string;
    prefix?: JSX.Element;
    suffix?: JSX.Element;
    clearable?: boolean;
    onClear?: () => void;
    clearLabel?: string;
    multiline?: boolean;
    monospace?: boolean;
    password?: boolean;
    markdown?: boolean;
    onSubmit?: () => void;
    lines?: number;
    abbreviations?: Record<string, string>;
    completions?: readonly Completion[];
  };
```

`type="text"`, `variant="default"` and `lines=3` are the defaults. Boolean modes are off unless enabled. `completions` and `abbreviations` apply to Markdown mode; see [completion data](/en/ui/input/autocomplete#api-reference). Native input attributes apply to the ordinary input; Markdown mode uses the editor contract.

## Accessibility

Prefer a visible `label`. When the surrounding layout cannot render one, pass
`"aria-label"`; a placeholder is not a persistent label.

Descriptions and errors are connected to the input. Inline errors use a live alert; with `externalErrorId`, your composition owns the visible error and its announcement. Clear and password controls have accessible names.

## Runtime

The field renders in server HTML. Editing, clearing, password visibility, markdown behavior, and callbacks require browser code.

## Example

```tsx
const [query, setQuery] = createSignal("");

<TextInput
  type="search"
  label="Search projects"
  description="Search by name or owner."
  icon="ti ti-search"
  value={query}
  onValueChange={setQuery}
  clearable
/>;
```
