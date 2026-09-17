# Media preview

`Lightbox` presents one or more images in a modal viewer. `PdfPreview` requests a PDF and displays the resulting document. The caller owns media access, URLs, and generation.

## Use media preview

Use `Lightbox` when a page already shows an image or thumbnail and readers need a larger view.

Use `PdfPreview` when a user action generates or loads a PDF for inspection. Use a normal download link when inline inspection is not part of the task.

## Import

```tsx
import {
  Lightbox,
  PdfPreview,
  type LightboxImage,
  type PdfPreviewProps,
  type PdfPreviewRequest,
} from "@k2b/ui";
```

## Images

Each `LightboxImage` has a required `src` and optional `alt` and `downloadUrl`. Pass a meaningful `alt` for informative images. Omit it only when the image is decorative.

`initialIndex` selects the first visible image. The parent owns the open state and removes the component through `onClose`.

## PDF requests

`PdfPreview` accepts a `request` function that resolves to a `Blob` or `Response`. A failed response becomes an error state. A Blob with a declared type other than `application/pdf` is rejected.

The component provides separate actions to render inside the page or open the document in a new tab. `disabled` is a reactive guard for invalid form state or an unavailable renderer.

Set `autoLoad` when mounting the preview already follows an explicit user action, such as opening a preview dialog. It requests the PDF once after browser mount, unless disabled, and shows a loading state. It does not request during server rendering or automatically retry when `disabled` changes. The caller owns request cancellation, such as aborting a fetch when its dialog closes.

Authentication, request input, server-side rendering, and error sanitization remain with the caller.

## API reference

```ts
type LightboxImage = {
  src: string; alt?: string; downloadUrl?: string;
};

type PdfPreviewRequest = () => Promise<Response | Blob>;

type PdfPreviewProps = {
  request: PdfPreviewRequest; autoLoad?: boolean; disabled?: () => boolean; title?: string; buttonLabel?: string;
  openButtonLabel?: string; emptyText?: string; class?: string;
};
```

`Lightbox` requires `images: LightboxImage[]` and `onClose: () => void`; `initialIndex?: number` defaults to 0. `PdfPreview.disabled` is an accessor, not a direct boolean. Omitted labels use localized defaults; without `autoLoad`, `request` runs only after a preview/open action.

## Accessibility

The lightbox uses a native dialog, labeled navigation controls, arrow keys, Escape, swipe gestures, and visible image position. Captions come from `alt`.

`PdfPreview` labels its iframe with `title`. Keep the open and preview button labels specific when several documents appear on one page.

## Runtime

Both components require hydration. `Lightbox` calls `showModal()` after mount. `PdfPreview` creates and revokes browser object URLs after loading a preview. A late response after unmount cannot display a preview or retain an object URL.

The server may render their initial markup, but modal behavior, network requests, Blob URLs, and navigation controls run in the browser.

## Example

```tsx
const [lightboxOpen, setLightboxOpen] = createSignal(false);

const images: LightboxImage[] = [
  {
    src: "/api/files/cover/preview",
    alt: "Report cover",
    downloadUrl: "/api/files/cover/download",
  },
];

<Show when={lightboxOpen()}>
  <Lightbox images={images} onClose={() => setLightboxOpen(false)} />
</Show>

<PdfPreview
  title="Generated report"
  request={() => fetch("/api/reports/42/pdf")}
  disabled={() => reportMutation.loading()}
/>
```
