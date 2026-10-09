# Media preview

`Lightbox` presents one or more images in a modal viewer. `VideoPlayer` plays one video with the browser's own controls. `PdfPreview` requests a PDF and displays the resulting document. `ZoomPanViewport` makes any content, such as a diagram, zoomable, pannable, and viewable fullscreen. The caller owns media access, URLs, and generation.

## Use media preview

Use `Lightbox` when a page already shows an image or thumbnail and readers need a larger view.

Use `VideoPlayer` wherever a stored video should play in place, such as a file preview or an attachment dialog. Do not wrap it in a `Lightbox`.

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
  VideoPlayer,
  type VideoPlayerProps,
  ZoomPanViewport,
  type ZoomPanAction,
  type ZoomPanFullscreen,
  type ZoomPanViewportProps,
} from "@k2b/ui";
```

## Images

Each `LightboxImage` has a required `src` and optional `alt` and `downloadUrl`. Pass a meaningful `alt` for informative images. Omit it only when the image is decorative.

`initialIndex` selects the first visible image. The parent owns the open state and removes the component through `onClose`.

## Video

`VideoPlayer` shows the video from `src` with the browser's native controls: play and pause, seeking, volume, playback speed where the browser offers it, and fullscreen. It never transcodes; the browser decodes what it can. `label` names the video for assistive technology, usually its file name.

The frame's size never depends on the video. It takes the height its host gives it, and where the host leaves the height open, it keeps `ratio`, width divided by height, 16:9 by default. The picture fits inside the frame without cropping on the muted inset surface, so a 9:16 reel and a wide recording both show whole. Nothing moves while the video loads, reports its size, or fails. For a reel on a phone, give the player the screen's height, for example in a dialog that fills the screen.

The browser fetches the video by range while it plays and seeks. Serve `src` inline, with its video media type, and answer `Range` requests with `206 Partial Content`; Safari plays nothing from a server that ignores them. A cross-origin `src` needs CORS headers that expose `Content-Range`. Set `crossOrigin="anonymous"` for a signed URL on another origin, so the browser sends no credentials.

`src` may be `null` while the host still fetches the address, for example a signed URL: the frame shows a loading state at its final size. Without `poster`, the player shows the video's first frame before playback, also on iOS.

Pass `renew` when `src` can expire during playback, such as a short-lived lease. When playback fails, the player asks `renew` for a fresh address of the same video and continues at the same time and speed, playing if it was. It does so after every expiry, also across long pauses. The renewed address starts at that point through a media fragment, `#t=`, in place of any fragment it brings, so the video does not show its beginning again. A renewed address that fails before it shows that point, or within ten seconds after, ends in the fallback, because a video that cannot play there fails again at once. Issue renewed addresses that stay valid much longer, a minute or more. Changing `src` itself starts a different video from the beginning.

When the browser cannot play the video, for example because of its codec, the frame shows a localized notice with `fallbackAction`, typically a download link, and calls `onFallback`. A video whose picture the browser cannot decode falls back as well, even when its sound would play: an HEVC recording from an iPhone plays in Safari, but a browser without an HEVC decoder would otherwise play only its sound in an empty frame.

Pass `error` to show the host's own content in the frame instead of the video, for example an error with a retry when fetching the address failed. The frame keeps its size, so nothing moves when the error appears or the retry succeeds.

## PDF requests

`PdfPreview` accepts a `request` function that resolves to a `Blob` or `Response`. A failed response becomes an error state. A Blob with a declared type other than `application/pdf` is rejected.

Until a document is shown, the viewer area shows a `Placeholder`: `emptyText` before the first request, `state="loading"` while a request runs, and `state="error"` with the message after a failure. The error state never adds a second retry: an on-demand preview retries with its render action in the toolbar. These states and the document share one box, so loading and errors do not move the page: the box fills the remaining height of a sized flex column and keeps an iframe's default height of 150 px where nothing sizes it. A long error scrolls inside that box from its top. Give the preview or its composed container a height when the document needs more room. While an on-demand preview renders again, the shown document stays until the new one arrives.

Without a `children` render function, the preview is a standalone frame: an optional `title` heading and the actions in a toolbar above the document. Spacing, not a divider line, separates the toolbar from the document.

The component provides separate actions to render inside the page or open the document in a new tab. `disabled` is a reactive guard for invalid form state or an unavailable renderer.

By default, the open action shows a temporary local copy of the document in a new tab. That copy has no file name and does not survive a reload, and Safari on iOS may download it instead. When the caller can serve the document itself, pass `openHref`: a stable same-origin URL that returns the PDF with `Content-Disposition: inline`. The open action then becomes a plain link to that URL in a new tab without an opener, so the browser's viewer can reload the document and shows the file name from the last path segment. The caller owns the URL, its authorization, and its response headers.

Pass `onDownload` to add a **Download** action. The caller owns the download, for example issuing a fresh attachment URL with the right file name; `disabled` also disables it.

Set `autoLoad` when mounting the preview already follows an explicit user action, such as opening a preview dialog. It requests the PDF once after browser mount, unless disabled, and shows the loading placeholder. The server and the page before hydration already render that loading state, without a render or retry action, while an `openHref` link works as a plain link. It does not request during server rendering or automatically retry when `disabled` changes. The caller owns request cancellation, such as aborting a fetch when its dialog closes.

An automatic preview shows one fixed document, such as a stored file. The open action opens the shown document without another request. The render action appears only while no document is shown and none is loading, for example when `disabled` kept the preview from starting. After a failed request, the render action moves into the error state as its retry, labeled with `buttonLabel` or **Retry**; beside `renderError` content, it stays in the toolbar and in place while it loads. Remount the preview to show a different document. Without `autoLoad`, both actions request the current document, so a preview of editable input stays current.

Authentication, request input, server-side rendering, and error sanitization remain with the caller.

### Compose a dialog or pane

Pass a `children` render function to place `actions` and `content` in an existing container. The preview then omits its own border, heading, and toolbar; `class` only applies to its default shell. Render each part at most once. A host with its own open and download actions, such as an automatic preview of a stored file, can leave `actions` out. The same request state, disabled controls, and object URL cleanup apply in either layout.

For a dialog, put `actions` in `PanelDialog.Header` and `content` in a flex column that fills the remaining body height. Keep explanatory text in `InlineGuidance` above the content. Do not put another preview card inside the dialog.

Use `renderError(message)` for application-specific recovery, such as a `NoticeCard` with a return-to-form action. It replaces the default error state; the toolbar keeps the render action, which retries. Errors replace the document, including a previously rendered PDF after a failed reload. Keep an accessible alert role in custom error content. A blocked new tab is not a document error: a localized alert beside the actions says so, and the shown document stays.

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
  openButtonLabel?: string; openHref?: string; onDownload?: () => void; emptyText?: string; class?: string;
  children?: (parts: { actions: JSX.Element; content: JSX.Element }) => JSX.Element;
  renderError?: (message: string) => JSX.Element;
};
```

```ts
type VideoPlayerProps = {
  src: string | null; label: string; poster?: string; ratio?: number;
  crossOrigin?: "anonymous" | "use-credentials"; renew?: () => Promise<string>;
  fallbackAction?: JSX.Element; error?: JSX.Element; onFallback?: () => void; class?: string;
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

`PdfPreview` labels its iframe with `title`. Its actions are native buttons named by their visible labels; with `openHref`, the open action is a native link, which a disabled preview replaces with a disabled button. Keep the open and preview button labels specific when several documents appear on one page; for a stored file, an open label such as "Open in new tab" says where the document appears. The viewer's loading state is a polite status and its error state an alert. When a retry removes the focused retry action, focus moves to the open action once the document is shown, to the document itself when the host leaves `actions` out, or to the retry of a new error state.

`VideoPlayer` names its video with `label`. The browser's controls bring their own labels and keyboard support. With focus on the video, the player adds the same keys in every engine: Space and `K` play and pause, the left and right arrows seek five seconds, `M` mutes, and `F` opens fullscreen. Focus draws its ring around the frame. The loading state is a polite status. The fallback is an alert that names the problem and offers its action; when it replaces the focused video, focus moves to that action, or to the frame when there is none.

`ZoomPanViewport` is a focusable group with the caller's `label` and a localized description of its keys. With focus on the viewport, `+` and `-` zoom, `0` resets, `F` opens fullscreen, and arrow keys pan when zoomed in. At fit, arrow keys keep scrolling the page. Every control has a localized label and a tooltip with its key. Motion is off under `prefers-reduced-motion`.

## Runtime

`Lightbox` and `PdfPreview` require hydration. `Lightbox` calls `showModal()` after mount. `PdfPreview` creates and revokes browser object URLs after loading a preview. A late response after unmount cannot display a preview or retain an object URL.

The server may render their initial markup, but modal behavior, network requests, Blob URLs, and navigation controls run in the browser.

`VideoPlayer` renders its frame and video element on the server, so the frame holds its size before hydration. Renewal, the keys, and the fallback need hydration.

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
<PanelDialog.Body scrollFade={false}>
  <VideoPlayer
    src={leaseUrl()}
    label={file.name}
    crossOrigin="anonymous"
    renew={async () => (await issueLease(file.path)).url}
    fallbackAction={<a href={downloadUrl} download={file.name}>Download</a>}
    error={leaseFailed() ? <Placeholder state="error" description="Could not load the video." action={retry} /> : undefined}
  />
</PanelDialog.Body>
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
