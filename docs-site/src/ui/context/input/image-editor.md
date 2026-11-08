# ImageEditor

`ImageEditor` edits one photo before the caller downloads or stores it. Crop,
rotation, flips, straightening, adjustments, looks, annotations, and opaque
redactions share one undo history. The heavy view loads when the component
mounts in a browser; server rendering shows its loading state.

The photo sits on one calm grey canvas. Floating overlays sit on top of it:
info chips at the top, a view bar with an optional image strip at the bottom,
and a tool pane on the right with the save actions at its foot. The photo can
be panned and zoomed freely, also under these overlays. The overlays use the
shared glass [`k2b-overlay-surface`](/en/ui/surfaces/utilities); menus,
dialogs, and every control inside keep the shared solid styles. With reduced
transparency or more contrast the overlays turn solid.

## Use ImageEditor

Use it for a complete photo-editing task with an explicit save. Use
[`ImageCropper`](/en/ui/input/image-cropper) when the caller needs only crop
coordinates and owns the preview and export.

## Import

```tsx
import { ImageEditor, type ImageEditorFeatures } from "@k2b/ui";

const features = {
  crop: true, rotate: true, straighten: true, adjust: true,
  filters: true, annotate: true, redact: true,
  export: { formats: ["image/jpeg", "image/png", "image/webp"], quality: true, resize: true },
} satisfies ImageEditorFeatures;

<ImageEditor source={file} title={file.name} features={features} onSave={upload} onCancel={close} />;
```

Each absent feature is off. The editor inherits the UI locale; it has no
locale prop. English and German controls use the same layout.

## Runtime

### Load a photo without loading its original

`source` is a `File`, `Blob`, or same-origin/CORS URL. For a remote original,
pass existing `previews` and `sourceSize`. Opening then loads only a suitable
bounded preview. The original loads when saving. Preview dimensions never
replace the original dimensions used for export.

```tsx
<ImageEditor
  source={originalUrl}
  sourceSize={{ width: 6000, height: 4000, type: "image/jpeg" }}
  previews={[{ source: previewUrl, width: 1500, height: 1000 }]}
  features={features}
  onSave={upload}
/>
```

Changing `source` starts a new history and cancels stale work. Unmounting
releases the preview, canvases, event listeners, and outstanding editor work.
The caller owns its upload cancellation and must finish or reject that promise.
The editor accepts formats the browser decodes. Callers can convert additional
formats before supplying them; Tools supplies its own HEIF conversion.

## Choose the available edits

The pane has up to three tools: **Crop**, **Adjust**, and **Mark up**.

- `crop` accepts `true` or `{ aspects, defaultAspect, locked }`. Aspects are
  `"free"`, `"original"`, `"1:1"`, `"4:5"`, `"3:2"`, `"4:3"`, `"16:9"`,
  `"9:16"`, or `{ width, height, label }`. The default is `"free"` when offered,
  otherwise the first aspect. `defaultAspect` overrides it. Aspect selection
  and portrait/landscape swaps share the edit history. `locked` preserves the
  configured ratio, including after a quarter turn.
- `rotate` enables quarter turns and horizontal/vertical flips.
- `straighten` enables −45° through 45° on a ruler. The image fills the crop
  without leaving empty corners.
- `adjust` enables brightness, contrast, saturation, warmth, vignette, and
  grain, and the **Auto** button. Auto measures the framed photo and moves the
  brightness, contrast, saturation, and warmth sliders to the computed values
  as one undo step. Those sliders stay freely adjustable; each carries a quiet
  "Auto" tag while its value still equals the computed one. Auto is an
  analysis that returns slider values, not a filter.
- `filters` enables Natural, Vivid, Warm, Cool, Mono, Soft, Mono hard, Faded,
  and Vintage with adjustable strength, shown as a strip of previews above the
  sliders. The `ImageEditorLook` values are `"original"`, `"vivid"`, `"warm"`,
  `"cool"`, `"mono"`, `"soft"`, `"mono-hard"`, `"faded"`, and `"vintage"`.
- `annotate` accepts `true` or `{ tools }`, using `"pen"`, `"highlighter"`,
  `"arrow"`, `"rect"`, `"ellipse"`, and `"text"`. Text is typed on the photo;
  a double-click on text edits it.
- `redact` adds **Redact** to Mark up: opaque black rectangles drawn above all
  other edits.
- `export` accepts `true` or `{ formats, quality, resize }`. Available formats
  are the intersection with the browser's verified encoders. The **Output**
  summary above the save actions opens these settings.

### Layers

Mark up lists every mark as a layer, the topmost first. A row shows the kind in
the mark's colour, a name, an eye, and delete. Clicking a row or a mark on the
canvas selects it: drag moves it, its corners resize it, and colour and size
apply to it. Drag a row's grip or press Alt + arrow keys to reorder.
Redactions form a fixed group at the top and only reorder among themselves, so
nothing ever covers a redaction.

A hidden mark is neither drawn nor exported, and the save area says so.
Redactions cannot be hidden: their eye shows what lies underneath only while it
is held, so every saved image contains every redaction. Annotations carry
`id` and `hidden`; render and export skip hidden marks but always draw
redactions.

## Example

A minimal caller needs only:

```tsx
<ImageEditor
  source={file}
  features={{ crop: { aspects: ["1:1"], locked: true }, rotate: true }}
  onSave={saveAvatar}
/>
```

## Describe the photo and its neighbours

- `title` names the photo in the first chip; it defaults to a `File`'s name.
  Size and format chips follow. `facts` adds chips such as a file version or
  "Read only" (`{ label, icon, tooltip }`).
- `notice` is a quiet line above the save actions for the whole session, such
  as why saving a version is locked. `redactionNotice` appears while the photo
  has redactions, for example when older unredacted versions stay in a history.
- `items`, `currentItem`, and `onSelectItem` show the image strip beside the
  view bar: the caller's other photos, the current one ringed, unsaved ones
  marked (`dirty`). `thumbnail` is a small URL or a function that renders the
  caller's own thumbnail. The caller swaps `source` on selection and keeps one
  editor per image when edits must survive the switch. `onAddItems` adds a "+"
  at the end. The strip fades only on a side with more images, keeps its
  height, and moves focus with the arrow keys, Home, and End. On phones it
  opens below the chips from the name chip. Keep each item's `id` stable:
  thumbnail and dirty-state updates preserve its button, focus, and scroll position.

## Save only after the caller succeeds

Without `saveActions`, **Done** encodes the result and awaits `onSave`.
`saveActions` replaces that button with caller-owned actions, such as a
`SplitButton` with the main way to save and the others in its menu. Its `save`
function encodes the captured history entry, then awaits `commit`. `busy`
covers preview loading, encoding, and the caller's work. The reactive,
read-only `formats` array starts empty and then lists the browser-verified
encoders allowed by `features.export.formats`. Check it before offering a save
that must preserve an existing file format.

```tsx
<ImageEditor
  source={file}
  features={features}
  saveActions={(actions) => (
    <Button disabled={actions.busy} loading={actions.busy}
      onClick={() => void actions.save(upload)}>
      Save a copy
    </Button>
  )}
/>
```

Only successful completion marks the captured entry saved. Editing continues
while a save runs; edits made during an upload remain dirty. A failed export or
rejected commit keeps edits and shows the error and retry action above the save
actions (on phones below the chips). `save` handles the failure visibly and
resolves after the attempt; success belongs to the caller's completed
`commit`, not to the promise merely settling.

When a rejected commit needs another action, set `saveErrorAction` to
`{ label, onClick }`, for example **Save copy** after a version conflict.
Clear it before a new attempt. Export failures retain the editor's own retry,
including explicit acceptance of a smaller output when necessary.

`onDirtyChange` reports whether the current history entry differs from the last
successfully saved entry. Undoing to that entry clears dirty; branching from
an earlier entry stays dirty. One slider gesture is one history step.
Completed edits and Undo update the preview immediately. In-progress gestures
combine preview updates into animation frames.

Close asks before discarding edits. The editor warns on reload/close and uses
`onBeforeLeave` from `@k2b/ssr/nav` for enhanced navigation.

## Output sizes, formats, and metadata

`output` accepts `{ format, quality, maxLongEdge }`. Format defaults to
`"same"`: preserve an encodable source type, otherwise choose JPEG for opaque
images or PNG when transparency is present. Quality defaults to `0.9`.

`maxOutputMegapixels` defaults to `16.7`. A positive number changes the output
budget; `"device"` attempts the requested source size. The encoder checks the
actual output at runtime. A size refusal preserves edits and offers a smaller
size that requires an explicit second save. It never silently returns a
smaller result after refusing a larger one.

The editor announces downscaling with a chip and a line above the save actions.
Saving always removes location and other source metadata. Cropping and
annotations are nondestructive until export; redactions cover the exported
pixels.

`ImageEditorResult` contains `blob`, `width`, `height`, `type`,
`originalWidth`, `originalHeight`, and `downscaled`. `type` is one of
`"image/jpeg"`, `"image/png"`, `"image/webp"`; the actual encoded MIME type is
checked. The caller owns file names, persistence, permissions, and revisions.

## Accessibility, view, and phone layout

Fit places the whole photo inside the overlays; small photos stay at 100 %.
Drag the empty canvas, hold Space and drag, or scroll with a trackpad to pan.
A mouse wheel, Ctrl/Cmd + wheel, or a pinch zooms around the pointer.
Double-click switches between fit and 100 %. At least a strip of the photo
always stays on the canvas.

Shortcuts show in the tooltips and under the keyboard button (`?`):
1, 2, and 3 choose the tools; Shift + 1 fits; Shift + 0 shows 100 %; + and −
zoom; Ctrl/Cmd + Z undoes and Shift + Ctrl/Cmd + Z redoes; holding O shows the
photo before adjustments and Shift + O splits before and after; Shift + A runs
Auto; R rotates while cropping; P, M, A, R, E, T, and S choose mark-up tools;
[ and ] change the size; Delete removes the selected mark and Escape clears the
selection. Arrow keys pan the focused canvas, move the focused crop (Shift
resizes it), and nudge a selected mark.

Give the editor a parent with a defined height (for example a flex workspace).
It fills that height, with a minimum of 34 rem. The canvas keeps its place when
tools, save status, or errors change. On phones the tools become a bottom sheet
with the tool tabs under the controls, the chips get compact, and saving moves
to the top right. The host owns its page title, back navigation, and app menu.
