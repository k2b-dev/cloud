# Cloud file chooser

`chooseFiles()` lets a user add files from this device or from any Cloud
application that offers files, and returns ordinary `File` objects. The
consuming application hands them to its existing upload path, so its limits,
progress, permissions, and checks stay as they are.

## Use the file chooser

Use it for the one "Attach" or "Add files" action of an upload. Call it from
the click or key handler of that action. Providers load only when a file action
starts; the chooser opens on **This device** while its sources load. Discovery
failures offer **Try again** in the same frame. After an earlier action found
no providers, the next action opens the device's file dialog directly and
needs that user activation.

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
- `maxBytes` is the largest single file the consumer takes from a provider.
  The provider's read limit applies as well; larger files are shown disabled
  with the smaller limit.
- `maxFiles` and `maxTotalBytes` bound one choice, for example the
  attachments a draft can still take and Mail's attachment limit. Above
  them, **Add** stays disabled and the status says why in red. A file above
  `maxTotalBytes` is disabled like one above `maxBytes`. Without them, only
  the limit per file applies. Files picked or dropped from this device meet
  the same limits: the status says why and the chooser stays open; without
  providers a toast says why and it resolves `[]`.
- `context` names what the person works on as resource refs, for example
  the contacts a mail goes to, as `{ refs }` or as an async function that
  runs only when someone opens a provider that accepts it. Only such
  providers receive it, and they decide which files match. Refs are hints,
  never access.
- `noMatchingFiles` titles the empty root of a provider that received
  `context`, for example **No matching files for these recipients**. It
  defaults to **No matching files**.
- `signal` closes the chooser and resolves `[]`. While the device's own
  dialog is open, an abort resolves `[]` at once and a later pick is dropped.

It resolves the chosen files in the order shown, or `[]` when the user
cancels. Names from providers are cleaned of control characters, path
separators, and bidi controls. Images, PDF, audio, video, and Office files
get the type their first bytes prove, active content such as HTML or SVG
becomes `application/octet-stream` unless `accept` names it, and other types
keep the provider's; see
[File providers](/en/docs/platform/file-providers#add-files-from-providers).

## Presentation

The chooser is a compact file dialog of one fixed size: 680 × 480 px on
wider screens, a full-height sheet below 48 rem. Moving between sources,
folders, and states never resizes or moves it.

- **Sources on the left:** **This device** first, then every provider in
  name order, as 36 px rows on the dialog surface. The open source carries
  the selected edge of the edge rule: a light app-blue fill with a 2 px edge.
  While the catalog loads, two grey loading rows hold the providers' place; a
  failed load leaves **Try again** in the same height. On phones the sources
  are a row of tabs under the title.
- **This device opens first** with a drop zone that fills the content. A
  click on the zone or on **This device** opens the device's dialog in the
  same click; arrow keys in the sources only move focus.
- **Inside a provider,** a toolbar row with **Up**, the path from the
  provider's name, and the name filter sits on the first source's line. On
  phones the filter hides behind a button. The list is a `FileGrid` in
  `layout="list"` with `checks`: a check box (a circle for one file), a
  neutral tile, the name with up to three provider tags, and below it
  "1.2 MB · 28/10/2026" or "Folder · date". Folders show a chevron and open
  with one click; a click on a file toggles it, a double click or Enter adds
  it. Only icons, no thumbnails. Sorting follows the provider.
- **Pages:** 50 entries per page with **Load more**. Past 500 entries, a hint
  to filter by name takes its place. The filter asks the provider after
  250 ms and cancels the earlier request.
- **Footer:** the status on the left, **Cancel** and **Add (n)** on the
  right. **Add** keeps one width for every count and is disabled on **This
  device** and without a selection. The status names the selection, the
  limits before anything is chosen, or the reason **Add** is disabled. On
  phones the status sits above two 48 px buttons.

States are grey loading rows of fixed height while a folder loads, empty
folder, no matching files for the caller's `context`, no matches with
**Clear filter**, no access and folder gone with **Up**, provider not
available and offline with **Try again**, and files that do not fit, grey
with the reason in place of size and date ("Over 25 MB" on phones). A
provider whose root answers 403 or 404 leaves the sources, and the status
says it is no longer available. After **Add**, each file shows its progress;
at most three download at once. **Cancel** stops them and returns to the
folder with the selection kept; finished downloads are discarded. If a file
fails, **Add** tries the failed files again. Files dragged over the open
dialog are taken like files from this device.

## Accessibility

Focus starts on **This device**. Arrow keys move between sources, and
Enter, Space, or a click opens one. In the list, arrow keys move between
rows, Enter opens a folder, Space toggles a file, and Enter on a file adds
the selection. Files that cannot be chosen stay focus stops, marked
`aria-disabled`, so their reason is read out. Escape clears the selection
first, then closes the chooser and returns focus to the action that opened
it; Back on a phone closes it too. Each folder change is announced with its
name and number of entries, and loading states are announced politely.

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

The dialog uses the chooser's frame: the applications that store files sit
on the left, and it opens in the first; with none, it says calmly that no
application can store files and suggests the download. Files appear in the
folder list but are disabled, so people see taken names. The footer status
says **Choose a folder**, **You cannot save in this folder**, or **Saves to
Docs**, and **Save** is enabled only in a writable folder.

After **Save**, each file shows its progress. A taken name turns that file's
row into a name field prefilled as `Report (2).pdf` with its own **Save**;
Enter saves it too. Failed files name the reason, and the footer **Save**
tries them again. **Cancel**, Escape, and Back on a phone stop what is still
running; files already saved stay saved. When the dialog closes after
saving, a confirmation toast links to the saved file, for example **Show in
Files**.

Focus starts on the open application. After **Save**, it moves to **Cancel**,
then to the first name field or the footer **Save** when a file needs the
person. The title names the file or the number of files.

## Runtime

The chooser and the save dialog share the provider list, read from the
capability catalog while the page is idle and once more behind the kept list
each time a dialog opens, and call each provider's `list`, `read`, and `save`
capabilities as the signed-in user.
Every provider authorizes each call. See
[File providers](/en/docs/platform/file-providers) for the contract.

## Example

```ts
const files = await chooseFiles({ multiple: true, maxFiles: 20, maxTotalBytes: 100 * 1024 * 1024 });
if (files.length > 0) await uploadAttachments(files);
```
