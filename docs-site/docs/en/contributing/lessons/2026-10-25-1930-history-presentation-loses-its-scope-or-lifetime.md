### History presentation loses its scope or lifetime

- **What happened:** Name-only grouping combines homonyms, folder details omit child changes, a late lookup overrides navigation, or elapsed hours misplace local midnight.
- **Root cause:** History presentation loses its scope or lifetime.
- **Error class:** History presentation loses its scope or lifetime.
- **Guard:** Tests: Files `history-actions.test.ts` separates visible identities, `history-requests.test.ts` and `urls.test.ts` preserve folder scope, `history-ranges.test.ts` pins DST boundaries, and `history-workspace.behavior.test.tsx` covers child uploads and obsolete navigation results/errors. `files-ui.render.test.tsx` and the workspace behavior test keep moved notices exclusive of load errors.
