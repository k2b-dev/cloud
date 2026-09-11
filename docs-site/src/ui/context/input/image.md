# ImageInput

`ImageInput` opens a file picker, transforms the selected image, and returns a data URL. The parent owns the value, storage, and upload.

## Use ImageInput

Use it for a single generic image field with an immediate preview.

Use `FileDropzone` for drag-and-drop or multiple files. Compose
`ImageCropper` with your own save flow when users need crop controls.

## Import

```tsx
import { ImageInput } from "@k2b/ui";
```

## Value and transformation

Pass a data URL, image URL, or `null` directly or through a Solid accessor.
After a successful transform or removal, the component reports the new value
through both `onValueChange` and `onValueCommit`.

The default transform accepts JPEG, PNG, GIF, WebP, and SVG, then uses the
avatar preset to produce a square 512×512 WebP. SVG files are decoded by the
browser and rasterized before export. Pass `transform(file)` for banners or
other images that must preserve a different aspect ratio. `accept` overrides
the default file-picker filter.

`variant="default"` renders a large preview. `variant="small"` renders a compact
preview with square, borderless icon actions. `round` changes the preview shape.

The input is read-only when `onValueChange` is absent. URLs containing the
configured `fallbackMarker` are treated as an unset value.

## API reference

See [shared field props](/en/ui/getting-started#shared-field-props) for `FieldProps`, `ValueFieldProps<T>` and `MaybeAccessor<T>`.

```ts
type ImageInputProps = ValueFieldProps<string | null> & {
  round?: boolean; variant?: "default" | "small"; transform?: (file: File) => Promise<string>;
  accept?: string; fallbackMarker?: string;
};
```

`transform` resolves to the image string stored in `value`, normally a data URL. It is not an upload callback. `fallbackMarker` defaults to `"?fallback"`; a value containing it is treated as a fallback instead of a selected image. Defaults: `round=false`, `variant="default"`.

## Accessibility

Provide a visible `label`, or set `"aria-label"` for the image preview. Change
and remove controls include their own accessible names.

File type and size restrictions still need validation in the owning upload path.

## Runtime

The browser file picker and image transformation require hydrated Solid client code.

## Example

```tsx
const [image, setImage] = createSignal<string | null>(null);

<ImageInput
  label="Project image"
  value={image}
  onValueChange={setImage}
/>;
```
