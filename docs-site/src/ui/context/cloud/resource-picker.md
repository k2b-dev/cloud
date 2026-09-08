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

The picker owns its dialog, search input, app filter, tags, loading and error states, and result selection. It returns the selected search item or `undefined` when the dialog closes without a selection.

Store `selected.ref` as the durable identity. Treat the returned title, preview, metadata, and links as presentation data that may change.

Available options are:

- `title` and `placeholder` for task-specific copy;
- `initialAppId` to preselect one searchable application;
- `excludeRefs` to hide resources already selected;
- `requireReader` to show only Types with a canonical reader.

## Accessibility

The dialog provides its title as its accessible name, moves focus into the search interaction, and supports closing with Escape. Search results and app filtering are keyboard operable. Use a task-specific `title` when the surrounding workflow needs more context than “Choose Cloud resource.”

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
