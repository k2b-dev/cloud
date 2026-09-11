# ImageCropper

`ImageCropper` selects a crop rectangle and rotation for one image. It emits crop state; the parent decides when and how to create the output image.

## Use ImageCropper

Use it after an image has been selected and the user must control the visible region.

Use `ImageInput` when the default image transform is sufficient and no crop UI is needed.

## Import

```tsx
import {
  createCroppedImageDataUrl,
  ImageCropper,
  type ImageCropState,
} from "@k2b/ui";
```

## Source and crop state

`source` accepts a `File`, `Blob`, image element, canvas element, or URL. `onValueChange` receives `{ crop, rotation }` after the image is ready, or `null` while no valid crop is available.

`aspect` defaults to `"free"`. Pass `{ width, height }` for a fixed ratio. `previewShape="circle"` changes only the preview mask; exported pixels still use the rectangular crop.

Rectangular crops can be moved and resized from their corners. A fixed `aspect` stays locked and keeps the opposite corner anchored during resize. A circular preview can be moved but has no corner handles. Rotation advances in 90-degree steps.

When the crop surface is focused, arrow keys move it and Shift+arrow resizes
it. The same clamping and fixed-aspect rules apply to pointer and keyboard
editing.

Use `createCroppedImageDataUrl` or `createCroppedImageCanvas` to apply the emitted state. Output options support exact dimensions, maximum dimensions, format, and quality.

## API reference

```ts
type ImageCropAspect = "free" | { width: number; height: number };

type ImageCropRotation = 0 | 90 | 180 | 270;

type ImageCropRect = { x: number; y: number; width: number; height: number };

type ImageCropState = { crop: ImageCropRect; rotation: ImageCropRotation };

type ImageCropSource = File | Blob | HTMLImageElement | HTMLCanvasElement | string;

type ImageCropOutput = {
  width?: number; height?: number; maxWidth?: number; maxHeight?: number; format?: "webp" | "jpeg" | "png";
  quality?: number;
};

type ImageCropSize = { width: number; height: number };

type ImageCropperProps = {
  source: ImageCropSource; aspect?: ImageCropAspect; previewShape?: "rect" | "circle"; disabled?: boolean;
  onValueChange?: (state: ImageCropState | null) => void; class?: string;
};
```

Crop x/y/width/height are fractions of the **rotated** image, from 0 to 1, measured from its top-left corner. Output dimensions are pixels. Defaults: `aspect="free"`, `previewShape="rect"`, `disabled=false`. Source-load failure reports `null`; the host must handle a missing crop state.

```ts
declare function createCroppedImageCanvas(source: ImageCropSource, state: ImageCropState, output?: ImageCropOutput): Promise<HTMLCanvasElement>;
declare function createCroppedImageDataUrl(source: ImageCropSource, state: ImageCropState, output?: ImageCropOutput): Promise<string>;
declare function imageCropRectToPixels(rect: ImageCropRect, imageSize: ImageCropSize): ImageCropRect;
declare function getInitialImageCropRect(imageSize: ImageCropSize, aspect?: ImageCropAspect): ImageCropRect;
declare function clampImageCropRect(rect: ImageCropRect, imageSize: ImageCropSize, aspect?: ImageCropAspect): ImageCropRect;
declare function resizeImageCropAroundCenter(rect: ImageCropRect, imageSize: ImageCropSize, aspect: ImageCropAspect, scale: number): ImageCropRect;
declare function normalizeImageCropRotation(rotation: number): ImageCropRotation;
declare function rotateImageCropRight(rotation: ImageCropRotation): ImageCropRotation;
```

Exports rotate, crop, then resize. Explicit `width`/`height` take precedence over maximum dimensions; `maxWidth`/`maxHeight` only downscale and preserve aspect ratio. With no output dimensions, the crop retains its pixel size. Data URLs default to WebP at quality `0.86`; quality is a 0–1 encoder value. Loading/encoding can reject, so await and handle failure. `normalizeImageCropRotation` rounds to a quarter turn; `rotateImageCropRight` adds 90°. A resize scale above 1 shrinks the crop around its center.

## Accessibility

Rotation, moving, and resizing are keyboard operable. Keep a reset path and do
not require pixel-perfect placement to complete the task.

Give the generated preview a useful `alt` value in the owning UI.

## Runtime

Image loading, pointer interaction, canvas export, and object URLs require hydrated browser code. Revoke and replacement of temporary object URLs is handled by the component.

## Example

```tsx
const [crop, setCrop] = createSignal<ImageCropState | null>(null);

<ImageCropper
  source={file}
  aspect={{ width: 1, height: 1 }}
  previewShape="circle"
  onValueChange={setCrop}
/>;

const state = crop();
if (state) {
  const result = await createCroppedImageDataUrl(file, state, {
    maxWidth: 480,
    maxHeight: 480,
    format: "webp",
  });
}
```
