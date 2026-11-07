### Small islands must keep small static imports

- **What happened:** A PWA counter loaded the full workspace layout, and a pairing notice loaded unrelated schema validators.
- **Root cause:** The counter imported a compound component object, while phone helpers imported path constants through the contracts barrel.
- **Error class:** Transitive browser bundle growth through broad imports.
- **Guard:** The island-bundles repository rule builds the production static closure of each small PWA island and enforces a measured byte budget.
