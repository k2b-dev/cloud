# Application details and published versions

Load the publication tools only when needed:
`load_tools({"names":["code_update","code_publish","code_versions","code_restore"]})`.

Choose a fitting icon with `code_create` or change working metadata with
`code_update`. Use full Tabler class names. Useful choices:

| Purpose | Icon |
| --- | --- |
| Calculator | `ti ti-calculator` |
| Checklist | `ti ti-list-check` |
| Dashboard | `ti ti-chart-bar` |
| Calendar | `ti ti-calendar` |
| Budget | `ti ti-wallet` |
| Inventory | `ti ti-package` |
| Reading | `ti ti-book` |
| Utilities | `ti ti-tool` |
| Time tracking | `ti ti-clock` |
| People | `ti ti-users` |

The normal cycle is create, edit, test, publish, use, edit, test, publish.
Personal applications can be published without granting anybody access.
There is no preview mode: users start applications. Use-level users only receive
the latest publication. Admins can run older published versions from Studio.

`code_versions` lists numbered publications with notes, authors, and dates;
`code_history` is the separate automatic source-save history. For rollback, read
the current working revision, call `code_restore` with the selected publication
and expectedRevision. This atomically updates the working source and creates a
new latest publication with an automatic "Restore version X" note. Do not publish
again after restoring. Test the selected historical version before restoring;
it never deletes history or restores user data. A concurrent write produces a
conflict: read the new state and reconcile instead of blindly retrying. Coordinate
overlapping edits; do not build branching machinery for ordinary single-user apps.

Sharing and publishing are independent. Project-linked scripts are available only
in that project’s chats to its current members. That context does not grant
editing, forking, or visibility in the global Studio list.
