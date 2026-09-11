# Documentation components

The `Doc*` components compose short in-product help, setup guides, and technical references. The host owns the content structure, routes, and navigation.

## Use documentation components

Use them when help is rendered inside an application and should match the surrounding product UI.

Use Fibel for the standalone developer documentation site. Use `MarkdownView` when the source is already Markdown and does not need a custom Solid composition.

## Import

```tsx
import {
  DocCode,
  DocConceptGrid,
  DocInlineCode,
  DocLead,
  DocNote,
  DocPage,
  DocRows,
  DocSection,
  type DocCodeHighlighter,
  type DocCodeProps,
  type DocConcept,
  type DocNoteVariant,
  type DocRow,
} from "@k2b/ui";
```

## Composition

`DocPage` supplies a centered reading width and text rhythm. Add one `DocLead` when the reader needs orientation before the first task or concept.

`DocSection` groups one topic under a heading and optional eyebrow. `DocConceptGrid` introduces a small set of concepts. `DocRows` presents repeated reference items without building nested cards.

`DocNote` separates an `info`, `tip`, or `warning` from normal prose. Use it for a real constraint or decision, not visual variety.

`DocInlineCode` marks literal paths, names, flags, and tokens.

The [API reference](#api-reference) defines `DocConcept`, `DocRow` and code options.

`DocConceptGrid` and `DocRows` add the `ti` family class themselves, so their
`icon` values are bare Tabler names such as `ti-shield-lock`. This differs from
`Widget`, `StatCell`, and `NoticeCard`, which take the complete class.

## Code examples

`DocCode` accepts source text, an optional title, language highlighting, line numbers, formatting, and copying.

Pass `highlight` when an application has its own DSL. The function receives one line at a time and returns highlighted HTML. `format` transforms the complete source before highlighting and copying.

Do not put secrets or user-specific values in examples.

## API reference

```ts
type DocConcept = {
  title: string; icon: string; text: JSX.Element;
};

type DocRow = {
  title: string; icon?: string; text: JSX.Element;
};

type DocCodeHighlighter = (code: string) => string;

type DocCodeProps = {
  code: string; title?: string; language?: CodeDisplayLanguage; highlight?: DocCodeHighlighter;
  format?: (code: string) => string; copy?: boolean; copyText?: string; lineNumbers?: boolean; class?: string;
};
```

`DocCode.copyText` overrides what is copied; otherwise the formatted source is copied. `lineNumbers` and `copy` default to false; `language` defaults to `"text"`. `highlight` returns trusted HTML for one line, so escape text in a custom highlighter. Other members: `DocPage`, `DocLead`, `DocInlineCode` accept JSX children; `DocSection` requires `title: string` and children, with optional `eyebrow: string`; `DocConceptGrid`/`DocRows` require `items` arrays of the shapes above. `DocNote` requires `title: string` and children, with `variant?: "info" | "tip" | "warning"` (default info).

## Accessibility

Keep the surrounding page heading hierarchy correct. `DocSection` renders a second-level heading, so it belongs below the page heading.

Concept icons supplement visible titles and descriptions. Notes always include a title. Code remains selectable text and the copy control has an accessible label.

## Runtime

The reading structure and highlighted code render on the server. Copy controls require hydration.

These components do not load documents, build navigation, or sanitize arbitrary HTML.

## Example

```tsx
<DocPage>
  <DocLead>
    Route policies protect the HTTP boundary. Services repeat resource checks.
  </DocLead>

  <DocSection title="Request flow" eyebrow="Identity and access">
    <DocRows
      items={[
        {
          title: "Route policy",
          icon: "ti-shield-lock",
          text: "Rejects callers that cannot enter the endpoint.",
        },
        {
          title: "Resource check",
          icon: "ti-key",
          text: "Protects the exact record read or changed by the service.",
        },
      ]}
    />
  </DocSection>

  <DocNote title="Keep both checks" variant="warning">
    SSR pages call services directly and do not pass through route middleware.
  </DocNote>
</DocPage>
```
