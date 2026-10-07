# Store app data

Read [cloud contract](cloud.md) for signatures and limits. Choose storage by owner:

| Data | Store |
| --- | --- |
| My preferences or todos, on every device | `cloud.kv.user` |
| Small settings shared by app users | `cloud.kv` |
| Records several people add or edit | `cloud.db` |
| Shared files | `cloud.files` |

KV supports get, set, delete, and sorted keys with `{after,limit}` paging
(default 100, maximum 1,000). Missing values return null. Each scope allows
1,000 keys and 1 MiB per value. Writes are last-writer-wins. Personal storage
is server-side and isolated by app and signed-in viewer; callers cannot select
another person. Anonymous visitors receive `denied`.

Shared file reads return File or null; write accepts Blob or string, at most
16 MiB. Paths are relative. File listings return sorted paths. Await every write
and deletion before reporting success.

The Personal view shows only the viewer’s JSON data across devices. Shared data
administration requires Manage. Runtime data persists across source edits and
restores; forks start empty. Test runs affect the same real server data, so use
appropriate test records. Chat input files and captured downloads are separate.
Browser-local storage and OPFS are removed; there is no personal file store.
