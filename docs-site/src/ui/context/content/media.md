# Media preview

`Lightbox` presents one or more images in a modal viewer. `PdfPreview` requests a PDF and displays the resulting document. `ZoomPanViewport` makes any content, such as a diagram, zoomable, pannable, and viewable fullscreen. The caller owns media access, URLs, and generation.

## Use media preview

Use `Lightbox` when a page already shows an image or thumbnail and readers need a larger view.

Use `PdfPreview` when a user action generates or loads a PDF for inspection. Use a normal download link when inline inspection is not part of the task.

Use `ZoomPanViewport` when content has detail that does not fit its box, such as a diagram, plan, or large SVG. Do not use it for photos that already open in a `Lightbox`, or for content that should scroll.

## Import

```tsx
import {
  Lightbox,
  PdfPreview,
  type LightboxImage,
  type PdfPreviewProps,
  type PdfPreviewRequest,
  ZoomPanViewport,
  type ZoomPanAction,
  type ZoomPanFullscreen,
  type ZoomPanViewportProps,
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

### Compose a dialog or pane

Pass a `children` render function to place `actions` and `content` in an existing container. The preview then omits its own border, heading, and toolbar; `class` only applies to its default shell. Render each part once. The same request state, disabled controls, and object URL cleanup apply in either layout.

For a dialog, put `actions` in `PanelDialog.Header` and `content` in a flex column that fills the remaining body height. Keep explanatory text in `InlineGuidance` above the content. Do not put another preview card inside the dialog.

Use `renderError(message)` for application-specific recovery, such as a `NoticeCard` with a return-to-form action. Errors replace the document, including a previously rendered PDF after a failed reload; they are not centered inside an empty viewer. Keep an accessible alert role in custom error content.

## Zoomable content

`ZoomPanViewport` wraps its children in a focusable group named by `label`. The view always starts at fit, the untransformed layout, and zooms up to 8×. It applies one CSS transform, so SVG stays sharp and the content is never re-rendered. Zoom state is not persisted.

- The floating controls zoom in, zoom out, and reset. With `fullscreen`, a fourth control opens it.
- Ctrl or Cmd with the mouse wheel, and trackpad pinch, zoom toward the pointer. A plain wheel keeps scrolling the page. A two-finger pinch zooms on touch screens.
- Dragging pans only above fit, so clicks and text selection keep working at fit. A drag does not also click the content.
- Panning keeps the content on screen: content larger than the view covers it, smaller content stays inside it. The first child element is measured for this, so pass the diagram element itself.

Without a height, the viewport takes the height of its content. Give it a height to fit the content inside a fixed box. Content that should shrink into that box needs `max-width` and `max-height`; the stage sets both to `100%` on its direct children.

`controls="hover"` hides the controls until the pointer is over the viewport, it has focus, or it is zoomed in. Touch screens always show them. Use it where the content itself is the main interaction, such as an editor preview. With the default `visible`, the controls get their own band above the content.

`fullscreen` opens a dialog with `size: "full"`, the `title` as heading, a fresh copy of the content from `content()`, and the same controls at fit. Escape closes it and focus returns to the control or viewport that opened it. `actions` render as buttons below the view. Each button shows a pending state until a returned promise settles, so handle and report failures inside `onSelect`.

## API reference

```ts
type LightboxImage = {
  src: string; alt?: string; downloadUrl?: string;
};

type PdfPreviewRequest = () => Promise<Response | Blob>;

type PdfPreviewProps = {
  request: PdfPreviewRequest; autoLoad?: boolean; disabled?: () => boolean; title?: string; buttonLabel?: string;
  openButtonLabel?: string; emptyText?: string; class?: string;
  children?: (parts: { actions: JSX.Element; content: JSX.Element }) => JSX.Element;
  renderError?: (message: string) => JSX.Element;
};
```

```ts
type ZoomPanAction = { label: string; icon?: string; onSelect: () => void | Promise<void> };

type ZoomPanFullscreen = {
  title: string; content: () => JSX.Element; actions?: readonly ZoomPanAction[];
};

type ZoomPanViewportProps = {
  label: string; children: JSX.Element; fullscreen?: ZoomPanFullscreen;
  controls?: "visible" | "hover"; class?: string; style?: JSX.CSSProperties;
};
```

`Lightbox` requires `images: LightboxImage[]` and `onClose: () => void`; `initialIndex?: number` defaults to 0. `PdfPreview.disabled` is an accessor, not a direct boolean. Omitted labels use localized defaults; without `autoLoad`, `request` runs only after a preview/open action.

## Accessibility

The lightbox uses a native dialog, labeled navigation controls, arrow keys, Escape, swipe gestures, and visible image position. Captions come from `alt`.

`PdfPreview` labels its iframe with `title`. Keep the open and preview button labels specific when several documents appear on one page.

`ZoomPanViewport` is a focusable group with the caller's `label` and a localized description of its keys. With focus on the viewport, `+` and `-` zoom, `0` resets, `F` opens fullscreen, and arrow keys pan when zoomed in. At fit, arrow keys keep scrolling the page. Every control has a localized label and a tooltip with its key. Motion is off under `prefers-reduced-motion`.

## Runtime

Both components require hydration. `Lightbox` calls `showModal()` after mount. `PdfPreview` creates and revokes browser object URLs after loading a preview. A late response after unmount cannot display a preview or retain an object URL.

The server may render their initial markup, but modal behavior, network requests, Blob URLs, and navigation controls run in the browser.

`ZoomPanViewport` renders at fit on the server; zoom, pan, and fullscreen need hydration. Mounting it in a separate Solid root, for example inside an editor widget, is supported: it falls back to the document locale.

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


```tsx
<ZoomPanViewport
  label="Diagram"
  fullscreen={{
    title: "Release plan",
    content: () => <img src={diagramUrl} alt="Release plan diagram" />,
    actions: [{ label: "Download SVG", icon: "ti ti-download", onSelect: () => downloadSvg() }],
  }}
>
  <img src={diagramUrl} alt="Release plan diagram" />
</ZoomPanViewport>
```

```tsx
<PdfPreview autoLoad title="Report" request={() => fetch("/api/reports/42/pdf")}>
  {(preview) => (
    <PanelDialog>
      <PanelDialog.Header title="Report preview" actions={preview.actions} close={close} />
      <PanelDialog.Body>{preview.content}</PanelDialog.Body>
    </PanelDialog>
  )}
</PdfPreview>
```
