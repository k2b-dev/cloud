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

## Import

```ts
import { chooseFiles } from "@k2b/cloud/browser/files";
```

## Options

- `accept` uses `<input accept>` syntax. Provider files that do not match are
  shown disabled, with the reason.
- `multiple` allows several files. It defaults to `false`.
- `maxBytes` is the largest file the consumer takes from a provider. The
  chooser uses the smaller of it and the provider's read limit; larger files
  are shown disabled with that limit. Device files are not checked here.
- `signal` closes the chooser and resolves `[]`.

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
files download at once; **Stop** cancels them and keeps the selection, and a
failed file can be tried again.

## Accessibility

Focus starts on **This device**. Arrow keys move between rows, Enter opens a
folder or a source, Space toggles a file, and Enter on a file adds the
selection. Escape closes the chooser and returns focus to the action that
opened it; Back on a phone does the same. Each folder change is announced
with its name and number of entries.

## Runtime

The chooser reads the provider list once per page from the capability catalog
and calls each provider's `list` and `read` capabilities as the signed-in user.
Every provider authorizes each call. See
[File providers](/en/docs/platform/file-providers) for the contract.

## Example

```ts
const files = await chooseFiles({ multiple: true, maxBytes: 100 * 1024 * 1024 });
if (files.length > 0) await uploadAttachments(files);
```
