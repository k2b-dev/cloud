# Cloud file chooser

`chooseFiles()` lets a user add files from this device or from any Cloud
application that offers files, and returns ordinary `File` objects. The
consuming application hands them to its existing upload path, so its limits,
progress, permissions, and checks stay as they are.

## Use the file chooser

Use it for the one "Attach" or "Add files" action of an upload. Call it from
the click or key handler of that action: without providers it opens the
device's file dialog directly and needs that user activation.

Do not add a second "From Cloud" button next to it, and do not use it to pick
a reference to a resource; use the
[resource picker](/en/ui/cloud/resource-picker) for that.

A `FileDropzone` or `ChatComposer` takes it as its `choose` function, so its
click or **Attach files** opens the chooser and drops keep their path. When a
dialog holds the dropzone, the chooser opens over it and returns to it, with
focus on the dropzone, when it closes.

## Import

```ts
import { chooseFiles } from "@k2b/cloud/browser/files";
```

## Options

- `accept` uses `<input accept>` syntax. Provider files that do not match are
  shown disabled, with the reason.
- `multiple` allows several files. It defaults to `false`.
- `maxBytes` is the most the consumer takes from providers in one choice:
  no single file and no selection together goes above it, so it also bounds
  what the browser holds. A single file is limited to the smaller of
  `maxBytes` and the provider's read limit; larger files are shown disabled
  with that limit. When the selected files add up to more, the status says
  so and **Add** stays disabled. Device files are not checked here.
- `signal` closes the chooser and resolves `[]`. While the device's own
  dialog is open, an abort resolves `[]` at once and a later pick is dropped.

It resolves the chosen files in the order shown, or `[]` when the user
cancels.

## Presentation

The chooser opens one dialog that keeps its size: full screen below 48 rem,
and one fixed frame on wider screens. The first view lists the sources:
**This device** first, then every provider in name order. Providers that are
still loading join below **This device** without moving it.

Inside a provider, a path row with **Up** and a name filter sits above one
folder at a time. The list is a `FileGrid` in `layout="list"`: a file icon,
the name, and its size and date, plus up to three provider tags as chips.
A tap or click on a file toggles it; folders open. **Load more** continues
long folders.

States are loading, empty folder, no matches with **Clear filter**, no access
and folder gone with **Up**, provider not available, and offline, the last two
with **Try again**. After **Add**, each file shows its progress. At most two
files download at once. **Cancel** stops them and returns to the folder with
the selection kept; finished downloads are discarded. If a file fails,
**Add** tries the failed files again.

The footer keeps its buttons in place: their labels never change, and the
status line says what is selected, why **Add** is disabled, or how many files
are ready. On phones the status line sits above the buttons.

## Accessibility

Focus starts on **This device**. Arrow keys move between rows, Enter opens a
folder or a source, Space toggles a file, and Enter on a file adds the
selection. Files that cannot be chosen stay focus stops, marked
`aria-disabled`, so their reason is read out. Escape clears the selection
first, then closes the chooser and returns focus to the action that opened
it; Back on a phone closes it too. Sources keep no selection, so Escape closes
from there at once. Each folder change is announced with its name and number
of entries.

## Save files

`saveFiles()` is the other direction: it saves copies of files a page already
shows into any Cloud application that stores files, such as Files. Offer it
beside each download, not instead of it.

```ts
import { SAVE_FILES_ICON, SaveFilesButton, saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";
```

- `SaveFilesButton` is an `IconButton` with the `ti-folder-down` icon. Pass
  `files`, an accessor of `{ name, content, mediaType?, size? }`, where
  `content` is a `Blob` or a same-origin URL such as the download route.
  With `all`, its label saves every file of a list.
- In menus and in a `Lightbox` image's `actions`, use
  `saveFilesLabel(locale)` and `SAVE_FILES_ICON` and call `saveFiles()`.
- The label names the application once the page knows that exactly one
  stores files, for example **Save report.pdf to Files**, and says
  **Save report.pdf to…** before that. Only the accessible name and tooltip
  change, so an icon button never moves. Do not use it as a text button.

The dialog uses the chooser's frame, path row, filter, and states. With one
application that stores files it opens straight in it, and the path starts
there; with several, the first view lists them; with none, it says calmly
that no application can store files and suggests the download. Files appear
in the folder list but are disabled, so people see taken names. The footer
status says **Choose a folder**, **You cannot save in this folder**, or
**Saves to Docs**, and **Save** is enabled only in a writable folder.

After **Save**, each file shows its progress. A taken name turns that file's
row into a name field prefilled as `Report (2).pdf` with its own **Save**;
Enter saves it too. Failed files name the reason, and the footer **Save**
tries them again. **Cancel**, Escape, and Back on a phone stop what is still
running; files already saved stay saved. When the dialog closes after
saving, a confirmation toast links to the saved file, for example **Show in
Files**.

Focus starts on the first folder. After **Save**, it moves to **Cancel**,
then to the first name field or the footer **Save** when a file needs the
person. The title names the file or the number of files.

## Runtime

The chooser and the save dialog share the provider list, read once per page
from the capability catalog, and call each provider's `list`, `read`, and
`save` capabilities as the signed-in user.
Every provider authorizes each call. See
[File providers](/en/docs/platform/file-providers) for the contract.

## Example

```ts
const files = await chooseFiles({ multiple: true, maxBytes: 100 * 1024 * 1024 });
if (files.length > 0) await uploadAttachments(files);
```
