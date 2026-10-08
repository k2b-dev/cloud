# FileDropTarget

`FileDropTarget` turns an area of the page into a drop target while files from
outside the page are dragged over the window. A calm overlay covers the area
and says in one sentence what dropping does. The parent owns validation beyond
the declared limits, uploads, progress, and persistence.

## Use FileDropTarget

Use it wherever a page or dialog can receive files: a chat composer, a folder
view, an email draft, a note, an attachment list. It makes the whole area the
target instead of a strip that has to be hit.

Keep a visible upload button next to it. Dropping needs a pointer; keyboard and
touch users choose files with the button. Use `FileDropzone` when the drop area
is also the visible control, for example the only content of a dialog.

Use `fileDropTarget` for a smaller, more specific target inside an area, such as
a folder row that receives files into that folder.

## Import

```tsx
import {
  FileDropTarget,
  fileDropTarget,
  type FileDropDetails,
  type FileDropOptions,
  type FileDropRejection,
  type FileDropTargetProps,
} from "@k2b/ui";
```

## Area

Render the component anywhere inside the area; it renders no layout box. Without
`for`, the area is the nearest native `<dialog>`, `AppWorkspace.Detail`, or
`AppWorkspace.Main` around it, and the whole window outside of them. Pass `for`
with an element to choose another area. The workspace sidebar and rail are
never part of the default area.

The overlay sits in the top layer over the visible part of the area. It never
takes the pointer and moves nothing: no layout shift, no movement on hover.
While files are over the window it shows a light frame and the sentence; over
the area the frame turns to the accent color. While an area is on the page, a
drop outside every target is refused, so the browser does not open the file and
leave the page.

## Which target takes the drop

- Only real file drags count: the drag's types include `Files`. Text, links,
  and elements dragged within the page never show an overlay, even an image
  that carries a file. Every drag that starts in the page gets the extra type
  `application/x-k2b-page-drag` when it starts, so a drag that is cancelled
  or whose source disappears leaves nothing behind.
- The most specific target under the pointer wins. A `fileDropTarget` element
  or a `FileDropzone` inside an area takes the drop, and the area's overlay
  shows its sentence while the pointer is over it. The element itself gets an
  inset ring through `data-file-drop="over"`.
- The topmost open modal dialog takes precedence. Targets inside it work;
  targets on the page or in dialogs behind it are off until it closes.
- A target whose own place is hidden is off, even when its area is visible:
  a lower level of a dialog stack, which stays in the same `<dialog>` while a
  question is open on top, or a pane hidden on a small screen.
- Two areas on the same element: the one rendered last wins. An area inside
  another shown area acts as a specific target.
- `disabled` takes a target out. A disabled specific target passes the drop to
  the area around it.

The overlay closes when the drag leaves the window, on drop, on `Escape`, when a
drag is cancelled, and when the page becomes hidden. An element removed under
the pointer does not keep it open.

## Files and limits

`onDrop(files, details)` runs synchronously inside the drop with the files that
fit. Read `details.dataTransfer.items` before the first `await` if you need
folder entries; some engines hand over a dropped folder only as an entry, and
then `files` is empty.

`accept` (`<input accept>` syntax), `multiple` (default `true`), `maxFiles`, and
`maxSize` (bytes per file) filter the drop. Files that do not fit are left out,
listed in `details.rejected`, and named in one error toast with the reason.
When `accept` lists only types, the engine exposes the types during the drag,
and none of them fits, the overlay says so and the drop is refused. An extension
in `accept` matches by file name, which only the drop reveals, and systems
report differing types for one extension, so with one the drop decides. Validate
size, content, and permissions again before upload.

## Accessibility

When the overlay appears, screen readers hear its sentence; after a drop they
hear which files were taken. The overlay itself is hidden from assistive
technology. Write the `label` as the outcome, such as "Drop to attach to the
message", and localize it like every other application string.

## Runtime

Drag tracking needs hydrated Solid client code. One tracker per document serves
every target. Server-rendered markup contains only the closed overlay.

## API reference

```ts
type FileDropOptions = {
  label: string;
  accept?: string;
  multiple?: boolean;
  maxFiles?: number;
  maxSize?: number;
  disabled?: boolean;
  onDrop: (files: File[], details: FileDropDetails) => void | Promise<void>;
};
type FileDropTargetProps = FileDropOptions & { for?: Element };
type FileDropDetails = { dataTransfer: DataTransfer; rejected: readonly FileDropRejection[] };
type FileDropRejection = { file: File; reason: "type" | "size" | "count" };

function fileDropTarget(options: FileDropOptions): (element: Element) => void;
```

Pass `fileDropTarget(...)` as an element's `ref`. Calling the ref again with
new options replaces them.

## Example

```tsx
<AppWorkspace.Main>
  <FolderList
    rowRef={(folder) =>
      fileDropTarget({ label: `Drop to upload to “${folder.name}”`, onDrop: (files) => upload(files, folder.path) })
    }
  />
  <FileDropTarget label={`Drop to upload to “${current.name}”`} onDrop={(files) => upload(files, current.path)} />
</AppWorkspace.Main>;
```
