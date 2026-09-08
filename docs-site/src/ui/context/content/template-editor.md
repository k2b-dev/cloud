# Template editor

`TemplateEditor` edits HTML and Liquid source with syntax highlighting and completions. The caller owns the template value, allowed variables, rendering, validation, persistence, and delivery.

## Use the template editor

Use it for operator-managed email, document, or PDF templates.

Compose it with `TemplatePreview` and `TemplateSampleData` when editors need to compare source and output. `createTemplateEditorPanesLayout()` provides the shared source-and-preview pane layout.

## Import

```tsx
import {
  createTemplateEditorPanesLayout,
  TemplateEditor,
  TemplatePreview,
  TemplateSampleData,
  type TemplateEditorLayout,
  type TemplateEditorProps,
  type TemplatePreviewProps,
  type TemplateSampleDataProps,
  type TemplateVariable,
  type TemplateVariableKind,
} from "@k2b/ui";
```

## State and variables

`TemplateEditor` is controlled through a direct `value` and
`onValueChange`. `variables` supplies completion names and optional kinds:

```ts
type TemplateVariable = {
  name: string;
  kind?: "string" | "email" | "url" | "number" | "boolean" | "array" | "object";
  description?: string;
};
```

Variables complete inside Liquid values and conditions. Array variables also complete as loops. HTML tag completions start with `<`.

`description` is rendered as the field description in `TemplateSampleData`.

`TemplateSampleData` edits string samples for the declared variables. The parent owns those values and passes the resulting rendered document to `TemplatePreview`.

## Rendering and composition

The editor does not render or save templates. The consuming application
chooses a renderer, escaping policy, allowed tags and filters, and input or
output limits.

`TemplatePreview` displays the caller's HTML in a sandboxed iframe. Keep preview rendering separate from the final delivery path and do not expose internal renderer errors to end users.

The interactive example illustrates editing, not a complete template renderer.

Use `fill` inside a stable pane or workspace. Use `lines` for a content-sized form.

## Accessibility

`TemplateEditor` inherits the keyboard, native textarea, composition, and toolbar behavior of `AutocompleteEditor`. Variable suggestions include visible names and kinds.

The preview iframe has the accessible name **Template preview**. Keep source editing available because the preview alone cannot communicate template structure.

## Runtime

Editing, completion, sample values, pane resizing, and reactive preview updates require hydration.

The host may produce a local preview when its renderer is browser-safe. PDF
generation and final delivery normally remain server operations.

## Example

```tsx
const variables: TemplateVariable[] = [
  { name: "APP_NAME", kind: "string" },
  { name: "LOGIN_URL", kind: "url" },
];

const [template, setTemplate] = createSignal(
  '<p>Welcome to {{ APP_NAME }}.</p><a href="{{ LOGIN_URL }}">Sign in</a>',
);
const [sample, setSample] = createSignal({
  APP_NAME: "Cloud",
  LOGIN_URL: "https://cloud.example.org/auth/login",
});

const preview = createMemo(() =>
  renderTemplate(template(), sample()),
);

<TemplateEditor
  value={template()}
  onValueChange={setTemplate}
  variables={variables}
/>

<TemplatePreview html={preview()} />

<TemplateSampleData
  variables={variables}
  values={sample()}
  onValueChange={(name, value) =>
    setSample((current) => ({ ...current, [name]: value }))
  }
/>
```
