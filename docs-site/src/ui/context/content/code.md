# Code

`CodeDisplay` renders highlighted, selectable source with optional title, line numbers, and copy action. `CodeDiff` shows a change between two versions line by line. The application owns the source text and its trust boundary.

## Use code

Use it for read-only snippets, generated configuration, and diagnostic payloads. Use `StructuredDataPreview` for data whose structure matters more than its serialized form.

## Import

```tsx
import {
  CodeDisplay,
  type CodeDisplayLanguage,
  type CodeDisplayProps,
} from "@k2b/ui";
```

`CodeDisplayLanguage` supports TypeScript, JavaScript, script, SQL, Markdown, and plain text modes. Line numbers and copy are enabled by default and can be disabled independently.

## API reference

```ts
type CodeDisplayLanguage = "ts" | "tsx" | "js" | "jsx" | "script" | "markdown" | "md" | "text" | "sql";

type CodeDisplayProps = {
  code: string; title?: string; language?: CodeDisplayLanguage; copy?: boolean; lineNumbers?: boolean;
  class?: string;
};
```

Defaults: `language="text"`, `copy=true`, `lineNumbers=true`. Set `copy={false}` or `lineNumbers={false}` independently.

## Accessibility

Source remains selectable text. Titles and copy controls have text labels. Highlighting must not be the only explanation of an important token.

## Runtime

Highlighting renders on the server. Copy requires browser code and the Clipboard API.

## Example

```tsx
<CodeDisplay
  title="health.ts"
  language="ts"
  code={`export const health = () => ({ ok: true });`}
/>
```

## Code differences

`CodeDiff` shows a read-only change between two versions of one or more files, line by line. The application computes the rows (for example on the server); the component counts line numbers, folds unchanged regions, and renders large files page by page.

```tsx
import {
  CodeDiff,
  type CodeDiffFile,
  type CodeDiffLine,
  type CodeDiffLineKind,
  type CodeDiffLocation,
  type CodeDiffProps,
} from "@k2b/ui";
```

```ts
type CodeDiffLineKind = "same" | "add" | "del";
type CodeDiffLine = { kind: CodeDiffLineKind; text: string };
type CodeDiffFile = { path: string; lines: readonly CodeDiffLine[]; language?: CodeDisplayLanguage };
type CodeDiffLocation = { path: string; line: number; side?: "new" | "old" };

type CodeDiffProps = {
  files: readonly CodeDiffFile[];
  mark?: CodeDiffLocation;
  file?: string; onFileChange?: (path: string) => void;
  status?: "loading" | "error"; errorDescription?: JSX.Element; onRetry?: () => void;
  label?: string; class?: string;
};
```

- **Rows:** each file lists its whole content in order. `same` is in both versions, `add` only in the new one, `del` only in the old one. Old and new line numbers are counted from the rows.
- **Layout:** one column with old number, new number, sign, and code. Added lines carry the success fill and `+`, removed lines the danger fill and `−`. Long lines wrap inside the code column. Below 30rem of its own width the number columns narrow.
- **Folding:** three unchanged lines stay around every change; longer unchanged runs fold into one row ("9 unchanged lines") that opens in place. A file without changes is one fold.
- **Files:** with more than one file, pill tabs name each file with `+added −removed`, `unchanged`, or the line count of a new file. The choice is internal unless `file` and `onFileChange` control it, for example from the URL.
- **New files:** a file whose rows are all `add` has no predecessor. It shows as whole code with one number column, without fills or signs. Say in the surrounding text why the whole code is shown.
- **Marking a line:** `mark` switches to its file (also when that file arrives later), opens the fold around the line, renders the pages up to it, marks it with the info fill and an inset bar, and scrolls it into view. Use `side: "old"` for a removed line. The server render already shows the marked line. What a mark revealed stays open when the mark goes away, and the person can still choose another file.
- **Pages:** 400 rows render at first; "Show 400 more lines" adds the next page and moves focus to its first row.
- **States:** `status="loading"` keeps the code surface with skeleton rows and one status label. `status="error"` shows "The code difference could not be loaded", the application's `errorDescription`, and "Try again" when `onRetry` is set. Code without any change shows "The code is unchanged".

Headings, version names, and the explanation of what a reviewer decides belong to the application around the component.

### Accessibility

The code is a labelled region ("Code difference, read only · index.ts"). Screen readers hear "Added, line 13:" or "Removed, line 11:" before every changed line and "Marked line." before the marked one; numbers and signs are hidden from them and from text selection. Fold rows and "Show more" are buttons; focus moves to the first revealed row. File tabs follow the `Tabs` keyboard model and control the code as their tab panel, which takes keyboard focus. Comments and every other syntax colour keep 4.5:1 on the muted, success, danger, and info fills.

### Example

```tsx
<CodeDiff
  files={[{ path: "reply.ts", lines: [
    { kind: "same", text: "const text = await ai.write({ prompt });" },
    { kind: "del", text: "await draft.create({ text });" },
    { kind: "add", text: "await message.reply({ text });" },
  ] }]}
  mark={{ path: "reply.ts", line: 2 }}
/>
```
