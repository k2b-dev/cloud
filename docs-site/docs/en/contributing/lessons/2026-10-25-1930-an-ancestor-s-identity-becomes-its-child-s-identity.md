### An ancestor's identity becomes its child's identity

- **What happened:** An old descendant address follows the moved folder's stable ID and opens or offers actions for the folder instead of the child.
- **Root cause:** An ancestor's identity becomes its child's identity.
- **Error class:** An ancestor's identity becomes its child's identity.
- **Guard:** Tests: Files `service/activity-reader.test.ts` scopes old paths to the visible before-side, keeps descendant chains probable and path-only, checks the current leaf, and stops at lifetime barriers and truncation. `activity-transports.test.ts` rejects unsafe old paths. UI `history-requests.test.ts`, `history.behavior.test.tsx` and `history-workspace.behavior.test.tsx` cover ancestor matching, the opened subject, and matching SSR/client requests without an automatic redirect.
