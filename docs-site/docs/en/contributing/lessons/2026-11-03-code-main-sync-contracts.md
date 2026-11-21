### A clean merge can violate integration-branch contracts

- **What happened:** After merging main into feat/code, the Mail Code fixture failed typechecking and two Mail activity-feed predicates failed the JSON SQL parameter check.
- **Root cause:** Main added a required sidebar snapshot field without the Code fixture, and its new activity-feed predicates passed serialized JSON directly to jsonb. Neither overlap produced a Git conflict.
- **Error class:** Semantic merge conflicts beyond conflict markers.
- **Guard:** Run touched-workspace typechecks and the integration branch's `sql-jsonb-text` check before pushing a sync. The fixture supplies `focusNoticeOpen: false`; the serialized assignee arrays pass through `::text::jsonb`.
