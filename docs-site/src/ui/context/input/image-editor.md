# ImageEditor

`ImageEditor` edits one photo before the caller downloads or stores it. Crop,
rotation, flips, straightening, adjustments, looks, annotations, and opaque
redactions share one undo history. The heavy view loads when the component
mounts in a browser; server rendering shows its loading state.

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

<ImageEditor source={file} features={features} onSave={upload} onCancel={close} />;
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

- `crop` accepts `true` or `{ aspects, defaultAspect, locked }`. Aspects are
  `"free"`, `"original"`, `"1:1"`, `"4:5"`, `"3:2"`, `"4:3"`, `"16:9"`,
  `"9:16"`, or `{ width, height, label }`. The default is `"free"` when offered,
  otherwise the first aspect. `defaultAspect` overrides it. Aspect selection
  and portrait/landscape swaps share the edit history. `locked` preserves the
  configured ratio, including after a quarter turn.
- `rotate` enables quarter turns and horizontal/vertical flips.
- `straighten` enables −45° through 45°. The image fills the crop without
  leaving empty corners.
- `adjust` enables brightness, contrast, saturation, warmth, vignette, and grain.
- `filters` enables Natural, Vivid, Warm, Cool, Mono, Soft, Mono hard, Faded,
  and Vintage with adjustable strength. The `ImageEditorLook` values are
  `"original"`, `"vivid"`, `"warm"`, `"cool"`, `"mono"`, `"soft"`,
  `"mono-hard"`, `"faded"`, and `"vintage"`.
- `annotate` accepts `true` or `{ tools }`, using `"pen"`, `"highlighter"`,
  `"arrow"`, `"rect"`, `"ellipse"`, and `"text"`. Text is edited on the photo.
- `redact` enables opaque black rectangles drawn above all other edits.
- `export` accepts `true` or `{ formats, quality, resize }`. Available formats
  are the intersection with the browser's verified encoders.

## Example

A minimal caller needs only:

```tsx
<ImageEditor
  source={file}
  features={{ crop: { aspects: ["1:1"], locked: true }, rotate: true }}
  onSave={saveAvatar}
/>
```

## Save only after the caller succeeds

Without `saveActions`, **Done** encodes the result and awaits `onSave`.
`saveActions` replaces that button with caller-owned actions. Its `save`
function encodes the captured history entry, then awaits `commit`.
`busy` covers preview loading, encoding, and the caller's work.
The reactive, read-only `formats` array starts empty and then lists the browser-verified
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

Only successful completion marks the captured entry saved. Edits made during
an upload remain dirty. A failed export or rejected commit keeps edits and
shows the error and retry action in the save status area. `save` handles the
failure visibly and resolves after the attempt; success belongs to the caller's
completed `commit`, not to the promise merely settling.

`onDirtyChange` reports whether the current history entry differs from the last
successfully saved entry. Undoing to that entry clears dirty; branching from
an earlier entry stays dirty. One slider gesture is one history step.
Completed edits and Undo update the preview immediately. In-progress gestures
combine preview updates into animation frames.

Cancel asks before discarding edits. The editor warns on reload/close and uses
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

The editor announces downscaling on opening and before saving. Saving always
removes location and other source metadata. Cropping and annotations are
nondestructive until export; redactions cover the exported pixels.

`ImageEditorResult` contains `blob`, `width`, `height`, `type`,
`originalWidth`, `originalHeight`, and `downscaled`. `type` is one of
`"image/jpeg"`, `"image/png"`, `"image/webp"`; the actual encoded MIME type is
checked. The caller owns file names, persistence, permissions, and revisions.

## Accessibility and phone layout

Arrow keys move the focused crop; Shift + arrow resizes it. Each corner also
accepts arrow keys. Ctrl/Cmd + Z undoes, Shift + Ctrl/Cmd + Z redoes. Shared
selection controls and sliders keep their keyboard behavior. Pinch zoom and
zoom buttons operate on the preview; **Fit** restores its position.
The shared **Tool** select keeps every enabled tool reachable without clipped
labels on narrow panels. Looks use shared preview tiles.

Give the editor a parent with a defined height (for example a flex workspace).
It fills that height, with a minimum of 34 rem and a maximum of 58 rem.
The canvas and tool regions keep their places when tools, save status, or
errors change. On phones, controls occupy a separate region below the canvas;
they do not cover it or introduce an application navigation dock. The host
owns its page title, back navigation, and app menu.
