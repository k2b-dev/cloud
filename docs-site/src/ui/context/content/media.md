# Media preview

`Lightbox` presents one or more images in a modal viewer. `QuickView` steps through a sequence of mixed items that the host draws. `VideoPlayer` plays one video with the browser's own controls. `PdfViewer` shows a PDF, from its bytes, its address, or a request, with pdf.js. `ZoomPanViewport` makes any content, such as a diagram, zoomable, pannable, and viewable fullscreen. The caller owns media access, URLs, and generation.

## Use media preview

Use `Lightbox` when a page already shows an image or thumbnail and readers need a larger view.

Use `QuickView` when people step through a sequence of mixed items, such as the files of a folder, and want a large look at each without leaving the page: Space opens it on a desktop, the arrow keys step. The host draws each item, so a photo, a PDF, and a text can share one view.

Use `VideoPlayer` wherever a stored video should play in place, such as a file preview or an attachment dialog. Do not wrap it in a `Lightbox`.

Use `PdfViewer` wherever a PDF should be read in place: a stored file, an attachment, or a document a user action generates. Use a normal download link when inline inspection is not part of the task.

Use `ZoomPanViewport` when content has detail that does not fit its box, such as a diagram, plan, or large SVG. Do not use it for photos that already open in a `Lightbox`, or for content that should scroll.

## Import

```tsx
import {
  Lightbox,
  type LightboxAction,
  type LightboxImage,
  PdfViewer,
  type PdfViewerProps,
  type PdfViewerRequest,
  QUICK_VIEW_ZOOM_STEPS,
  QuickView,
  type QuickViewAction,
  type QuickViewItem,
  type QuickViewProps,
  ThumbnailStrip,
  type ThumbnailStripItem,
  type ThumbnailStripProps,
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

An image may also carry `actions`: further things to do with that image, each a short `label`, a Tabler `icon` class, and `onClick`. They sit before **Download** in the same style and show their label on wider screens. Cloud apps use one for **Save to Files**. Keep the list short; the bar holds a few buttons, not a menu.

`initialIndex` selects the first visible image. The parent owns the open state and removes the component through `onClose`.

Two or three images show dots to switch between them. From four images on, a [`ThumbnailStrip`](#thumbnail-strip) replaces the dots. Pass a small version of each image as `thumbnail`; without it the strip loads `src`, which costs bandwidth for large photos. The counter, caption, buttons, arrows, dots, and strip float over the picture on dark glass (`k2b-overlay-surface`).

## Thumbnail strip

`ThumbnailStrip` is a row of image thumbnails, 44 px high, for switching between images: the gallery uses it, and an image editor or a file preview can too. Each item has an `id`, a `name`, an optional `thumbnail` (a URL, or a function that renders the host's own thumbnail component), and an optional `dirty` flag that adds a dot for unsaved edits. `currentItem` names the shown image; it is ringed and scrolled into the middle. `onSelectItem` receives an id. `onAddItems` adds a "+" tile at the end.

The strip scrolls sideways and fades softly only on the side where more images follow. The current image is the strip's one tab stop. The arrow keys, Home, and End move focus between the images and the "+" tile without showing them; Enter or a click shows one. A host that uses the arrow keys itself, as the gallery does for the previous and next image, does not also receive them while the strip has focus.

The host decides where the strip sits, also on a phone, and its surface: over a picture, pass `class="k2b-overlay-surface"`.

```tsx
<ThumbnailStrip
  label="Images"
  class="k2b-overlay-surface"
  items={photos().map((photo) => ({ id: photo.id, name: photo.name, thumbnail: photo.thumbUrl, dirty: photo.edited }))}
  currentItem={current()}
  onSelectItem={setCurrent}
  onAddItems={pickPhotos}
/>
```

## Quick view

`QuickView` is a large look at one item of a sequence. It covers the page with a quiet, blurred stage, so the page stays faintly visible behind it. The item's name stands in a chip at the top left, on one line that ends with an ellipsis; optional `facts` follow it quietly and give way first. The item's commands (`actions`) and Close are round buttons at the top right. One floating pill at the bottom holds previous, the position as "3 / 14", next, and −, the zoom, and +. Below it, a [`ThumbnailStrip`](#thumbnail-strip) shows the sequence on screens wider than 40rem; phones keep the stage for the item and step with the pill or a swipe.

The host owns `current` and draws the shown item with `children(item, zoom)`, mounted once per item. `zoom` is a factor of the fitted size, 1 at first and again on every item; apply it to the content, such as an image frame's width or `PdfViewer`'s `scale` with `zoom={false}`. Items without `zoomable` keep the zoom controls in place, disabled, so the pill never moves. Keep the item's loading, error, and retry states on the stage, in the item's place. The stage centres the item and scrolls both ways when it is zoomed beyond it.

```tsx
<Show when={shown()}>
  {(id) => (
    <QuickView items={items()} current={id()} onCurrentChange={setShown} onClose={() => setShown(null)} actions={(item) => [download(item)]}>
      {(item, zoom) => <PhotoFrame item={item} zoom={zoom()} />}
    </QuickView>
  )}
</Show>
```

## Video

`VideoPlayer` shows the video from `src` with the browser's native controls: play and pause, seeking, volume, playback speed where the browser offers it, and fullscreen. It never transcodes; the browser decodes what it can. `label` names the video for assistive technology, usually its file name.

The frame's size never depends on the video. It takes the height its host gives it, and where the host leaves the height open, it keeps `ratio`, width divided by height, 16:9 by default. The picture fits inside the frame without cropping on the muted inset surface, so a 9:16 reel and a wide recording both show whole. Nothing moves while the video loads, reports its size, or fails. For a reel on a phone, give the player the screen's height, for example in a dialog that fills the screen.

The browser fetches the video by range while it plays and seeks. Serve `src` inline, with its video media type, and answer `Range` requests with `206 Partial Content`; Safari plays nothing from a server that ignores them. A cross-origin `src` needs CORS headers that expose `Content-Range`. Set `crossOrigin="anonymous"` for a signed URL on another origin, so the browser sends no credentials.

`src` may be `null` while the host still fetches the address, for example a signed URL: the frame shows a loading state at its final size. Without `poster`, the player shows the video's first frame before playback, also on iOS.

Pass `renew` when `src` can expire during playback, such as a short-lived lease. When playback fails, the player asks `renew` for a fresh address of the same video and continues at the same time and speed, playing if it was. It does so after every expiry, also across long pauses. The renewed address starts at that point through a media fragment, `#t=`, in place of any fragment it brings, so the video does not show its beginning again. A renewed address that fails before it shows that point, or within ten seconds after, ends in the fallback, because a video that cannot play there fails again at once. Issue renewed addresses that stay valid much longer, a minute or more. Changing `src` itself starts a different video from the beginning.

When the browser cannot play the video, for example because of its codec, the frame shows a localized notice with `fallbackAction`, typically a download link, and calls `onFallback`. A video whose picture the browser cannot decode falls back as well, even when its sound would play: an HEVC recording from an iPhone plays in Safari, but a browser without an HEVC decoder would otherwise play only its sound in an empty frame.

Pass `error` to show the host's own content in the frame instead of the video, for example an error with a retry when fetching the address failed. The frame keeps its size, so nothing moves when the error appears or the retry succeeds.

## PDF viewer

`PdfViewer` is the one component for PDFs. Pass the document in one of three ways:

- `data` as a `Blob` or `ArrayBuffer` when the page already holds the bytes; it shows at once.
- `data` as the address of a PDF on this site; the viewer fetches it with the page's cookies and stops the request when the viewer goes or the address changes.
- `request`, a function that resolves to a `Blob` or `Response`, for a document the server generates. With `autoLoad`, it runs as soon as the viewer shows; without it, the empty state offers one action, named by `loadLabel`, and the pill keeps that action as an icon to render again. `disabled` keeps the request from starting, for example while the form behind it is incomplete.

A failed `Response` becomes the error state with its JSON `message` or the HTTP status; a Blob with a declared type other than `application/pdf` is rejected. The caller owns authentication, request input, server-side rendering, and error wording; a request that should stop when its dialog closes takes the dialog's abort signal.

The viewer is one grey area with the surface radius. The pages, the empty, loading, and error states, and the pill all lie in it, so nothing around it moves while a document arrives. The area takes the height its host gives it, also a smaller one, grows in a flex column, and is 12.5rem tall where nothing sizes it. A long error scrolls inside the area from its top. Do not put the viewer into another card or frame: its ground is the frame.

The pages lie one below the other in one scroll area, as images drawn by pdf.js, with an invisible text layer over each page, so text can be selected, copied, and found with the browser's search. pdf.js draws the same way in every browser, also on iPad, where an embedded PDF in a frame shows only its first page. Only pages near the view are drawn and carry text, and at most 24 drawn pages stay in memory; the others keep their size, so the scroll bar is right from the start.

The view starts fitted to the width: every page as wide as the area, so a landscape page among portrait ones never scrolls sideways. A fitted page never grows past 100 %, so zooming the browser out does not enlarge it. A small pill at the bottom shows the current page as "1 / 6", then −, the percentage, and +, which zoom in steps from 25 % to 300 %, and one icon that returns to the fit. The controls are icons only, each with its name as tooltip and accessible name; the pressed fit is its blue icon without a fill. Ctrl or ⌘ with the mouse wheel, a trackpad pinch, and two fingers zoom freely around the pointer. The pill is solid, and the area keeps room below the pages, so the end of the last page always scrolls clear of it. `zoom={false}` leaves the page number and zoom controls out and always fits; the open and render-again icons stay. `page` shows a single page (zero-based).

Pass `fit="page"` where the viewer is a preview beside other content, such as a details panel: the whole first page shows in the area's height, narrower than the area and centred, above the pill, and the fit icon returns to that view. Reading views keep the default `fit="width"`.

Pass `open` to add "Open in new tab" at the end of the pill, for printing, forms, or the browser's own viewer. `open` alone opens a temporary copy of the shown document; it has no file name and does not survive a reload. Pass a stable same-origin address instead, one that returns the PDF with `Content-Disposition: inline`, and the tab opens that address, reloads it, and shows its file name. When the browser blocks the tab, a short alert says so and the document stays. A host that already offers open and download actions, such as a dialog header, leaves `open` out.

When pdf.js cannot draw a document (broken, encrypted, without pages, or past the limits of 100 MiB and 2,000 pages), the area says "This PDF cannot be shown here" and offers the open action when `open` is set, and for an on-demand request also the action that renders again; `onError` reports it. There is no second viewer in a frame.

pdf.js loads only when a document shows. The @k2b/ui build ships it with its worker as two files that a host's bundler copies next to its chunks; neither enters a page's bundle, also not a classic script. pdf.js runs no code from the document and fetches nothing beyond the given bytes.

```tsx
<PdfViewer data={blob} title="Rental agreement" />
<PdfViewer data={`/api/files/${id}/inline`} open={`/api/files/${id}/inline`} title={file.name} />
<PdfViewer request={renderPreview} loadLabel="Render preview" emptyText="Render the template to inspect it." disabled={!valid()} open title="Invoice" />
```

### Migrate from PdfPreview

`PdfPreview` is gone; `PdfViewer` takes its place with the same request, states, and lazy pdf.js:

- `<PdfPreview request={r} …/>` becomes `<PdfViewer request={r} title=… />`; `title` is now required, `autoLoad` and `emptyText` stay.
- `buttonLabel` becomes `loadLabel`, and `disabled={() => x}` becomes `disabled={x}`.
- `openHref` and the open action become `open`: `true` for the shown document, or the address.
- `children` with `actions` and `content`, `renderError`, `openButtonLabel`, and `onDownload` are gone. Place the viewer in your container, keep download in your own header, and let the viewer's error state show the reason with its retry.
- The browser's viewer in a frame no longer takes over when pdf.js cannot draw a document; pass `open` so people can open it in a new tab.

### In a dialog or pane

Put the viewer in a flex column that fills the remaining height, with explanatory text in `InlineGuidance` above it. The dialog header keeps the title and close; the viewer brings its own states and actions. Do not wrap it in another preview card.

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
  actions?: readonly LightboxAction[]; thumbnail?: string;
};

type ThumbnailStripItem = { id: string; name: string; thumbnail?: string | (() => JSX.Element); dirty?: boolean };

type ThumbnailStripProps = {
  items: readonly ThumbnailStripItem[]; currentItem?: string; onSelectItem: (id: string) => void;
  onAddItems?: () => void; label: string; class?: string;
};

type LightboxAction = { label: string; icon: string; onClick: () => void };

type PdfViewerRequest = () => Promise<Response | Blob>;

type PdfViewerProps = {
  title: string; data?: Blob | ArrayBuffer | string; request?: PdfViewerRequest; autoLoad?: boolean;
  disabled?: boolean; emptyText?: string; loadLabel?: string; open?: boolean | string;
  zoom?: boolean; scale?: number; fit?: "width" | "page"; page?: number;
  onReady?: (document: { pages: number }) => void; onError?: (error: unknown) => void; class?: string;
};

type QuickViewItem = { id: string; name: string; facts?: string; thumbnail?: string | (() => JSX.Element); zoomable?: boolean };

type QuickViewAction = { label: string; icon: string; onClick: () => void };

type QuickViewProps = {
  items: readonly QuickViewItem[]; current: string; onCurrentChange: (id: string) => void; onClose: () => void;
  children: (item: QuickViewItem, zoom: Accessor<number>) => JSX.Element;
  actions?: (item: QuickViewItem) => readonly QuickViewAction[];
};
```

`QUICK_VIEW_ZOOM_STEPS` lists the factors − and + step through, from 0.5 to 3. `PdfViewer`'s `scale` applies only with `zoom={false}` and multiplies the fitted width, for a host such as `QuickView` that zooms with its own controls.

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

`Lightbox` requires `images: LightboxImage[]` and `onClose: () => void`; `initialIndex?: number` defaults to 0. Omitted labels use localized defaults; without `autoLoad`, `request` runs only after the load action.

## Accessibility

The lightbox uses a native dialog, labeled navigation controls, arrow keys, Escape, swipe gestures, and visible image position. Captions come from `alt`. A dialog that an image action opens above the lightbox keeps its own keys: Escape closes that dialog, and arrow keys stay in its fields.

`QuickView` is a native modal dialog named "Quick view: " and the item's name. Space and Escape close it, unless Space presses a focused button; the left and right arrows step, and so do up and down outside a scrolling document; `+`, `-`, and `0` zoom and fit. A swipe steps on touch screens while the item is not zoomed. The position is announced politely; every round button and pill control has its name as tooltip and accessible name. A cut name shows all of it as a native hint. Focus returns to the opener on close.

`PdfViewer` names its page area with `title`. The pill's icons carry their names as tooltips and accessible names; the state actions are native buttons named by their visible labels. Keep `loadLabel` specific when several documents appear on one page. The loading state is a polite status and the error state an alert; when a document turns out not to be drawable, the viewer announces that politely. While a placeholder shows, the viewer itself holds keyboard focus that would otherwise drop; once the first page is drawn, focus moves on to the pages.

`VideoPlayer` names its video with `label`. The browser's controls bring their own labels and keyboard support. With focus on the video, the player adds the same keys in every engine: Space and `K` play and pause, the left and right arrows seek five seconds, `M` mutes, and `F` opens fullscreen. Focus draws its ring around the frame. The loading state is a polite status. The fallback is an alert that names the problem and offers its action; when it replaces the focused video, focus moves to that action, or to the frame when there is none.

`ZoomPanViewport` is a focusable group with the caller's `label` and a localized description of its keys. With focus on the viewport, `+` and `-` zoom, `0` resets, `F` opens fullscreen, and arrow keys pan when zoomed in. At fit, arrow keys keep scrolling the page. Every control has a localized label and a tooltip with its key. Motion is off under `prefers-reduced-motion`.

## Runtime

`Lightbox`, `QuickView`, and `PdfViewer` require browser code. `Lightbox` and `QuickView` call `showModal()` after mount. `PdfViewer` renders its loading or empty state on the server and loads in the browser; a late response after unmount shows nothing. Only "Open in new tab" with `open` alone creates a temporary object URL, which it revokes after a minute.

The server may render their initial markup, but modal behavior, network requests, Blob URLs, and navigation controls run in the browser.

`VideoPlayer` renders its frame and video element on the server, so the frame holds its size before mount. Renewal, the keys, and the fallback require browser code.

`ZoomPanViewport` renders at fit on the server; zoom, pan, and fullscreen require browser code. Mounting it in a separate Solid root, for example inside an editor widget, is supported: it falls back to the document locale.

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

<PdfViewer
  title="Generated report"
  request={() => fetch("/api/reports/42/pdf")}
  disabled={reportMutation.loading()}
  open
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
<PanelDialog>
  <PanelDialog.Header title="Report preview" close={close} />
  <PanelDialog.Body scrollFade={false}>
    <PdfViewer autoLoad open title="Report" request={() => fetch("/api/reports/42/pdf", { signal })} />
  </PanelDialog.Body>
</PanelDialog>
```
