### Old Gustav turns kept an app's former name

- **What happened:** After the platform app was renamed from "Core" to "Cloud", earlier turns still read "In Notizbücher und Core nachgesehen".
- **Root cause:** A turn stores its steps' presentation, app name included, in `meta.toolPresentations`, and every chat surface rendered that stored name.
- **Error class:** A display name stored as a snapshot instead of being resolved from its catalog when shown.
- **Guard:** `public-projection.test.ts` renames an app and expects stored steps to show the current catalog name in the reader's language, and the stored name when the registry does not know the app.
