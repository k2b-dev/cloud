# Shared Files and Grids list

Upload `main.js` as a Studio app. Set shared KV key `sources` to:

```json
{
  "gridsTemplateId": "<ID from grids.document.templates>",
  "filesBaseId": "<ID from filesv2.bases.list>",
  "filesPath": ""
}
```

The app shows one page from each source, with separate next-page controls.
Files contains immediate files in the configured folder, not a recursive tree.
Grids contains stored documents for one template. Selecting a row and choosing
**Download selected file** fetches its content through the existing capability
stream. Grids downloads the primary artifact. No new document is rendered.

Each read checks the current user's access. Studio sandbox code uses
`capabilities.streams.read` and `files.save`, rather than fetching an application
URL. Ordinary authenticated Cloud pages can use Grids' `downloadUrl` directly.
Streams are scoped to the current run and limited to 50 MiB per file; create a
fresh stream for every download. This example neither persists streams nor
creates public shares. Its adapter and failure handling have automated tests;
installation in a user's Studio is a separate step.
