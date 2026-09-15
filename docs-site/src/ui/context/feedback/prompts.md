# Prompts

`prompts` opens modal alert, confirmation, input, search, form, and custom-dialog flows. Every method returns a promise, so the calling action can continue from the result.

The application owns the decision, validation rules, and side effect. The prompt owns modal stacking, focus, dismissal, and shared presentation.

## Use prompts

Use a prompt when the user must acknowledge information, choose a result, or provide a small amount of data before work continues.

Use a toast for non-blocking feedback. Use `PanelDialog` for a persistent editor with tabs, sections, or a larger application workflow.

## Import

```tsx
import {
  Button,
  DialogHeader,
  openSpotlightSearch,
  prompts,
  SpotlightButton,
  type PromptSearchItem,
} from "@k2b/ui";
```

## Properties

### Choose a prompt

| Method | Result | Use |
| --- | --- | --- |
| `prompts.alert(content, options)` | resolves when closed | Information that requires acknowledgement. |
| `prompts.success(content, options)` | resolves when closed | Successful result that requires acknowledgement. |
| `prompts.error(content, options)` | resolves when closed | Failure details that must be read. |
| `prompts.confirm(content, options)` | `boolean \| undefined` | One confirm-or-cancel decision. |
| `prompts.prompt(content, defaultValue, options)` | `string \| null` | One text value. |
| `prompts.promptNumber(content, defaultValue, options)` | `number \| null` | One numeric value with optional `min` and `max`. |
| `prompts.form(config)` | typed values or `null` | A small declarative form. |
| `prompts.search(resolver, options)` | selected item or `undefined` | An asynchronous picker. |
| `prompts.dialog(component, options)` | caller-defined result | Custom content and actions. |

Cancellation returns `false`, `null`, or `undefined` according to the method. Handle it before starting a mutation.

### Dialog options

| Property | Purpose |
| --- | --- |
| `title`, `icon` | Name the dialog and add a Tabler icon. |
| `confirmText`, `cancelText` | Override action labels. `cancelText: false` hides the cancel button in `prompts.form`. |
| `confirmationPhrase` | Requires an exact typed phrase before `prompts.confirm` can confirm. |
| `variant` | Selects `primary`, `success`, or `danger` action treatment. |
| `size` | Selects `small`, `medium`, `large`, or `wide`. |
| `surface` | Uses the standard panel or a caller-owned `bare` surface. |
| `header` | Set to `false` when a custom dialog owns its header. |
| `cancelBehavior` | `prompts.alert` can use `"ignore"` to keep Escape and backdrop clicks from closing it. |

Use `surface: "bare"` with `header: false` only when the custom content supplies complete visible panel structure and a close control.

## Typed confirmation

Use a non-empty, single-line `confirmationPhrase` for unusually consequential actions where an ordinary confirm-or-cancel decision does not provide enough friction. Empty, whitespace-only, multiline, and tab-containing phrases are rejected. The confirmation input receives focus, and the primary action remains disabled until the value matches the configured phrase exactly, including capitalization and spaces. Cancellation does not require entering the phrase.

`confirmText` continues to label the action button; it does not configure the phrase.

```tsx
const confirmed = await prompts.confirm(
  "Delete Project Atlas and all stored data?",
  {
    title: "Delete project",
    confirmText: "Delete project",
    confirmationPhrase: "Project Atlas",
    variant: "danger",
  },
);

if (!confirmed) return;
await deleteProject("atlas");
```

## Forms

`prompts.form` infers its return type from the field schema. Supported field types are:

- `text`, including multiline, password, and markdown options;
- `number`;
- `image`;
- `pin`;
- `select`;
- `tags`;
- `boolean`;
- `datetime`, with optional date-only mode;
- `info`, which displays content and is excluded from the result.

Fields share `label`, `description`, `placeholder`, `required`, `default`, and a `validate` function where applicable. Form-state validation checks required values, text-length and tag-count constraints, and the custom validator. A required boolean field must be checked. Number bounds and PIN length configure their controls but do not create additional form-state error messages.

```tsx
const values = await prompts.form({
  title: "Add member",
  icon: "ti ti-user-plus",
  fields: {
    name: {
      type: "text",
      label: "Name",
      required: true,
    },
    role: {
      type: "select",
      label: "Role",
      options: [
        { id: "admin", label: "Admin" },
        { id: "user", label: "User" },
      ],
    },
    active: {
      type: "boolean",
      label: "Active",
      default: true,
    },
  },
});

if (!values) return;
```

## Search

The search resolver receives the current query and an `AbortSignal`. It returns items with a `label` and optional `desc`, `icon`, root-relative `previewUrl`, or `value`. Results without `desc` use a compact single-line row; adding `desc` expands only that result to the two-line layout. Handle the selected value after the returned promise resolves; result items do not own application side effects.

Search options include `placeholder`, `initialQuery`, `minQueryLength`, `debounceMs`, `emptyText`, and `noResultsText`.

Honor the abort signal when the resolver calls a remote API:

```tsx
const selected = await prompts.search(
  async ({ query, abortSignal }) => {
    const response = await fetch(`/api/users?q=${encodeURIComponent(query)}`, {
      signal: abortSignal,
    });
    const users = await response.json();

    return users.map((user) => ({
      label: user.name,
      desc: user.email,
      value: user,
      icon: "ti ti-user",
    }));
  },
  {
    title: "Assign owner",
    minQueryLength: 1,
    noResultsText: "No matching people.",
  },
);
```

Use `openSpotlightSearch` for application or workspace navigation. It supplies search-oriented defaults around `prompts.search`. `SpotlightButton` provides matching triggers for ordinary, compact, chip, sidebar, mobile-sidebar, and icon placements.

The shortcut is one contract shared by every trigger, exported so the
application can bind the same keys it advertises: `SPOTLIGHT_SHORTCUT`
(`"mod+shift+k"`, the binding), `SPOTLIGHT_SHORTCUT_LABEL` (`"⇧⌘K"`, the chip
text, overridable per button through `shortcutLabel`), and
`SPOTLIGHT_SHORTCUT_TITLE` (`"Mod+Shift+K"`, used in the default `title`).

## Custom dialogs

`prompts.dialog` passes a typed `close(result)` callback to the component. Use it when the standard methods cannot express the content or actions.

The standard surface can provide the title and close row:

```tsx
const result = await prompts.dialog<"publish" | "draft">(
  (close) => (
    <div class="flex justify-end gap-2">
      <Button variant="secondary" onClick={() => close("draft")}>
        Save draft
      </Button>
      <Button onClick={() => close("publish")}>
        Publish
      </Button>
    </div>
  ),
  { title: "Publish changes", icon: "ti ti-rocket" },
);
```

For a bare surface, the caller owns all visible panel structure. `DialogHeader` remains available for that structure. A prompt opened from inside another prompt is stacked above it; the underlying Solid state stays mounted until the nested prompt closes.

```tsx
await prompts.dialog<void>(
  (close) => (
    <section class="my-dialog-surface">
      <DialogHeader
        title="Review changes"
        icon="ti ti-file-check"
        close={() => close()}
      />
      <p>The caller owns this panel background, spacing, and boundary.</p>
      <Button
        variant="secondary"
        onClick={() => void prompts.confirm("Return to the review?")}
      >
        Open nested confirmation
      </Button>
    </section>
  ),
  { surface: "bare", header: false },
);
```

## API reference

```ts
interface DialogOptions {
  signal?: AbortSignal; title?: string; ariaLabel?: string; icon?: string; confirmText?: string;
  cancelText?: string | false; variant?: "danger" | "primary" | "success";
  size?: "small" | "medium" | "large" | "wide"; surface?: "default" | "bare"; header?: false;
  cancelBehavior?: OpenDialogOptions["cancelBehavior"];
}

interface ConfirmOptions extends DialogOptions {
  confirmationPhrase?: string;
}

type PromptSearchInput = {
  query: string; abortSignal: AbortSignal;
};

type PromptSearchItem<T = unknown> = {
  label: string; desc?: string; icon?: string; previewUrl?: string; value?: T;
};

type PromptSearchOptions = DialogOptions & {
  placeholder?: string; icon?: string; initialQuery?: string; minQueryLength?: number; debounceMs?: number;
  emptyText?: string; noResultsText?: string;
};

type PromptFieldBase<T> = {
  label?: string | false; description?: string; placeholder?: string; required?: boolean; default?: T;
  validate?: (value: T | undefined) => string | null;
};

type FieldSchema =
  | (PromptFieldBase<string> & {
      type: "text";
      multiline?: boolean;
      lines?: number;
      maxLength?: number;
      minLength?: number;
      icon?: string;
      activeIcon?: string;
      password?: boolean;
      markdown?: boolean;
    })
  | (PromptFieldBase<number> & {
      type: "number";
      min?: number;
      max?: number;
      step?: number;
    })
  | (PromptFieldBase<string> & {
      type: "image";
      round?: boolean;
      ariaLabel?: string;
      accept?: string;
    })
  | (PromptFieldBase<string> & {
      type: "pin";
      length?: number;
      stretch?: boolean;
    })
  | (PromptFieldBase<string> & {
      type: "select";
      options: string[] | { id: string; label?: string; description?: string; icon?: string }[];
      icon?: string;
      activeIcon?: string;
      clearable?: boolean;
    })
  | (PromptFieldBase<string[]> & {
      type: "tags";
      maxTags?: number;
      minTags?: number;
      icon?: string;
      activeIcon?: string;
    })
  | (PromptFieldBase<boolean> & {
      type: "boolean";
    })
  | (PromptFieldBase<string> & {
      type: "datetime";
      dateOnly?: boolean;
    })
  | {
      type: "info";
      content: string | JSX.Element | (() => JSX.Element);
    };

type PromptFormOptions<T extends Record<string, FieldSchema>> = {
  signal?: AbortSignal; title?: string; ariaLabel?: string; icon?: string; fields: T; confirmText?: string;
  cancelText?: string | false; variant?: "danger" | "primary" | "success"; size?: DialogOptions["size"];
  cancelBehavior?: DialogOptions["cancelBehavior"];
};
```

`PromptFormOptions` describes the options passed to `prompts.form`; form output has the same non-info keys, with values inferred from each field type. Optional fields can be `undefined`. `validate(value)` returns an error string or `null`, synchronously. A required boolean must be true.

`prompts.search<T>(resolve, options?)` accepts `(input: PromptSearchInput) => PromptSearchItem<T>[] | Promise<PromptSearchItem<T>[]>` and resolves to the selected **item** or `undefined`, not just its value. `openSpotlightSearch` uses that same result. Use `result?.value` for the application payload. Search cancellation aborts the resolver's signal. `minQueryLength` defaults to 0 and `debounceMs` to 180 milliseconds.

`cancelBehavior` uses `"resolve-undefined" | "ignore"` from the dialog host. Low-level `dialogCore.open(render, options?)` returns a promise for the result or `undefined`; use the [dialog host contract](#dialog-host) when composing a custom modal.

## Dialog host

Use `dialogCore` for custom dialog composition; ordinary confirmation,
forms, and search should use `prompts`.

```ts
type DialogClose<T> = (result?: T) => void;

type OpenDialogOptions = {
  signal?: AbortSignal; panelClassName?: string; contentClassName?: string;
  initialFocus?: "first-input" | "none" | ((dialog: HTMLDialogElement) => HTMLElement | null);
  cancelBehavior?: "resolve-undefined" | "ignore"; ariaLabel?: string;
};

type DialogRender<T> = (
  close: DialogClose<T>,
  context: {
    dialog: HTMLDialogElement;
    setModal: (modal: boolean) => void;
    setPosition: (position: { x: number; y: number } | null) => void;
    requestDismiss: () => Promise<void>;
    setDismissHandler: (handler: () => void | Promise<void>) => void;
  },
) => JSX.Element;

type DialogCore = {
  open: <T>(view: DialogRender<T>, options?: OpenDialogOptions) => Promise<T | undefined>;
  close: (result?: unknown) => void; isOpen: () => boolean;
};
```

`dialogCore.open` resolves when that dialog closes. Escape/backdrop resolves
`undefined` by default; `cancelBehavior="ignore"` disables those dismissals.
`initialFocus` defaults to `"first-input"`. `setDismissHandler` routes Escape
and backdrop through the application's async guard; that handler must call
`close()` to complete dismissal. `dialogCore.close` addresses the top dialog.
Opening requires a browser and throws without `document`.

Custom windows can call `setModal(false)` to allow interaction with the page,
then `setModal(true)` to restore modality. This retains mounted content and
focus inside the window; the host updates page scroll locking and Escape
handling. A modeless window has no native backdrop. Escape respects handled
keyboard events and the same dismissal guard. Nested dialogs start modal and
restore the parent's mode when closed.

`setPosition({ x, y })` uses viewport coordinates and fixed positioning;
`setPosition(null)` restores the panel stylesheet's positioning. Mode and
position belong to each stack entry. The caller owns dragging, responsive
limits, persistence, and modeless stacking styles. Do not call the native
`show()`, `showModal()`, or `close()` methods to switch modes.

## Accessibility

Use specific titles and action labels. Destructive confirmations should name the object and consequence. Do not hide the cancel action when cancellation is a valid path.

The shared dialog core focuses the first input, textarea, select, or button by default and owns Escape handling. Custom bodies still need semantic headings, labelled controls, native buttons, and an explicit close path.

Search results need unique, descriptive labels. A preview or icon may supplement the label but cannot replace it.

## Runtime

Prompts are browser interactions and must be called from hydrated code. Their content is mounted through the shared `@k2b/ui` portal into one modal dialog stack at runtime.

Do not call a prompt during server rendering. Await it from an event handler, then start the mutation only after a confirmed result.

## Example

```tsx
const removeProject = async () => {
  const confirmed = await prompts.confirm(
    "Delete Project Atlas and its stored data?",
    {
      title: "Delete project",
      confirmText: "Delete project",
      variant: "danger",
    },
  );

  if (!confirmed) return;
  await deleteProject("atlas");
};
```

## Operation cancellation

All prompts accept an optional `signal: AbortSignal`. Aborting resolves the
prompt as cancellation and closes only that prompt, including when another
prompt is stacked above it. An already-aborted signal does not mount a dialog.
Use this to tie a prompt to an operation or component lifetime; it does not
confirm or submit the form. Normal dismissal and unmount remove the listener.

Repeated Escape does not bypass an ignored or guarded dismissal. If the browser
forces the native window closed, the shared dialog core restores retained
content, including an underlying dialog after its child closes. Close custom
dialogs through the supplied callback, not the native element's `close()` method.
