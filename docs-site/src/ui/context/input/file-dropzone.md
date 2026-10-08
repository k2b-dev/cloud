# FileDropzone

`FileDropzone` provides file-picker and drag-and-drop input. The parent owns validation beyond file type, upload progress, persistence, and the list of accepted files.

## Use FileDropzone

Use it for uploads where dropping files is a useful primary interaction.

Use `ImageInput` for one image with an immediate transformed preview.

Use `FileDropTarget` to let a whole page area or dialog receive files. A
`FileDropzone` inside such an area is the more specific target: it takes the
files dropped on it, and the area's overlay shows its sentence meanwhile. That
sentence is "Drop to upload" unless `dropLabel` says what dropping does here,
such as "Drop to convert the document to Markdown". Pass it whenever dropping
does something other than upload.

## Import

```tsx
import {
  FileDropzone,
  type FileDropzoneProps,
} from "@k2b/ui";
```

## Files and upload state

`onDrop` receives a `File[]` from either interaction. `multiple` defaults to `true`; when it is `false`, only the first file is emitted.

`accept` is a reactive string prop and is read when a picker or drop happens,
so changing a file policy does not require remounting the field. It is passed to
both the hidden file input and the drop handling. Dropped files that do not
match are left out and named in one error toast. Validate size, content, and
permissions again before upload.

Drops follow the shared `FileDropTarget` rules: only files dragged from outside
the page count, an open modal dialog takes precedence over the page behind it,
and the surface shows its drop state with `data-file-drop="over"` or
`data-file-drop="invalid"`.

The parent reports progress through `busy`. While busy, the dropzone is
disabled and shows its loading state. `error` accepts visible JSX. `title`,
`subtitle`, `hint`, and `icon` describe the upload task; while files are over
the surface, its title shows `dropLabel`.

The component does not retain selected files. Store them or start the upload in `onDrop`.

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for `FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`.

```ts
type FileDropzoneProps = FieldProps & {
  accept?: string; multiple?: boolean; busy?: boolean; icon?: string; title?: JSX.Element;
  subtitle?: JSX.Element; hint?: JSX.Element; dropLabel?: string; onDrop: (files: File[]) => void | Promise<void>;
};
```

`accept` uses native file-input syntax, such as `"image/*,.pdf"`. It filters the picker and dropped files. The callback may be asynchronous; the host controls `busy` and error feedback. `multiple=true`; `busy` and `disabled` default to false.

## Accessibility

The drop surface is a button, so it works with keyboard activation. Provide
`label`, `aria-label`, or a clear `title` that names the expected file.

Do not communicate file restrictions only through an icon or invalid-drag color. State them in `subtitle` or `hint`.

## Runtime

File selection and drag events require hydrated Solid client code. Server-rendered markup provides the initial field surface.

## Example

```tsx
<FileDropzone
  label="Attachment"
  accept="application/pdf"
  multiple={false}
  subtitle="PDF, up to 10 MB"
  busy={upload.loading()}
  error={upload.error()}
  onDrop={(files) => upload(files[0]!)}
/>;
```
