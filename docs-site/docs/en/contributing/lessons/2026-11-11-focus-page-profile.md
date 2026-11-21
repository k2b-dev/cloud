### Focus pages omitted the profile used by shared access UI

- **What happened:** Access dialogs and panels in a focus page could not mark the current person as “You”.
- **Root cause:** The focus branch rebuilt shell data without the request's profile.
- **Error class:** Alternate layouts drop request context required by shared consumers.
- **Guard:** `packages/cloud/src/ssr/Layout.render.test.tsx` compares embedded profiles on regular and focus pages and checks anonymous omission.
