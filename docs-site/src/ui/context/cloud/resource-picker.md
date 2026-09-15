# Cloud resource picker

The Cloud resource picker lets a user choose one permission-filtered Universal Search result and returns the result with its stable `CloudResourceRef`. The application decides what the selection means and how to persist it.

## Use the Cloud resource picker

Use the picker when a browser interaction needs a reference to a resource owned by any searchable Cloud application. Use `requireReader` when the consumer must later resolve the selected ref through its canonical reader. Use `initialAppId` to start within one application and `excludeRefs` to prevent duplicate selections.

Do not use it for application-local exhaustive browsing or as an authorization check. The owning search provider authorizes every result, and the consuming service must still authorize later reads or mutations.

## Import

```ts
import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";
```

## Selection ownership

The picker owns its dialog, search input, tag filters, loading, error states, and result selection. A click or Enter selects a result; **Add** confirms it. It returns the selected search item or `undefined` when the dialog closes without a selection.

Store `selected.ref` as the durable identity. Treat the returned title, preview, metadata, and links as presentation data that may change.

Available options are:

- `title` and `placeholder` for task-specific copy;
- `initialAppId` to start within one searchable application, shown as a removable scope chip;
- `excludeRefs` to hide resources already selected;
- `requireReader` to show only Types with a canonical reader.

## Presentation

The picker starts with a search field and a few tag suggestions. **All filters**
or typing `#` opens the full filter list in the result area. Aliases remain
searchable without appearing as duplicate filters. No application dropdown or
nested autocomplete menu is shown.

While loading, the spinner replaces the search icon. Quiet tag placeholders
reserve the suggestion row so opening the dialog does not shift its layout.

Desktop results share the dialog with a preview that starts at its top edge.
The dialog keeps a constant width and top position as results arrive; it grows
downward and scrolls within the available viewport height.
Small screens show one column with an optional **Details** view. The result list
uses `ScrollArea` fades, and empty results use a short inline message. Previous
results remain visible during a new request, but cannot be added until the
current request completes.

## Accessibility

The dialog provides its title as its accessible name, moves focus into the search interaction, and supports closing with Escape. Arrow keys navigate results or tag suggestions. Enter selects, Tab moves focus normally, and **Add** confirms the resource. Escape first leaves tag discovery or mobile details, then closes the dialog. Use a task-specific `title` when the surrounding workflow needs more context than “Choose Cloud resource.”

## Runtime

Call the picker from browser code. It uses the authenticated `/api/search` route and discovers the current application catalog from the running Cloud installation. Search providers remain responsible for permission-filtering every result. `requireReader` filters capabilities; it does not grant access or replace authorization.

## Example

```ts
const selected = await openCloudResourcePicker({
  title: "Add Cloud reference",
  excludeRefs: currentReferences,
  requireReader: true,
});

if (selected) {
  await saveReference(selected.ref, selected.title);
}
```

See [Universal Search](/en/docs/platform/search) for provider registration, resource refs, tags, readers, and authorization.
