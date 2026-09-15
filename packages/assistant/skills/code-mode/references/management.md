# Manage an App's data and lifecycle

Read this only for requested inspection, maintenance, export, or deletion.
Normal published actions need no management tools. All operations here require
Manage on the App. They use Studio's documented contracts; the backing service
is not an additional API and requires no vendor documentation.

Load only the tools needed for the requested operation through `load_tools` and
read their schemas. Every destructive tool below presents a fresh review of the
exact App and scope. No model-supplied confirmation or remembered approval can
replace that review. Re-read after conflicts; inspect an unknown outcome before
retrying. Never reset a database as a routine response to a query error.

| Task | Tools and inputs | Result and preserved data |
| --- | --- | --- |
| Inspect shared files or JSON keys | `code_storage_list({id,area:"files"|"kv",after?:string,limit?:number})` | `id,title,storageRevision,areas,items,nextAfter`; items contain `key,bytes,mediaType,version`. Default limit 100, maximum 1,000; continue with `nextAfter` until null. |
| Delete a key or clear storage | `code_storage_delete({id,area:"files"|"kv"|"all",key?:string,expectedStorageRevision})` | Omit key to clear the selected area; `all` cannot select a key. Returns `deleted:true` or `cleared:true`. Source, publications, and database stay intact. |
| Inspect database | `code_database_read({id})` | `configured,connected,generation,dataRevision,tables,unavailable`. No database is created; unavailable details and table count may be null. |
| Export database to chat | `code_database_export({id,path?:string})` | Default `/database.sqlite`. Returns chat file metadata including `path,version,size,mediaType`. Existing paths are rejected, not overwritten. Chat byte limits apply. Present the returned file; do not print its bytes. |
| Clear rows, keep schema | `code_database_clear({id,expectedGeneration,expectedDataRevision})` | `completed,clearedTables`; on failure also `failedTable,error,outcome`. Tables and schema survive, as do source and other storage. Earlier tables may already be empty; inspect before a new review. |
| Discard database and schema | `code_database_reset({id,expectedGeneration,expectedDataRevision})` | `connected:false,databaseCleanupQueued`. The next explicit connection starts empty. Source, publications, and files/JSON storage survive. Physical deletion is queued, not finished. |
| Withdraw publication | `code_unpublish({id,expectedPublishedVersion})` from `code_manage_read` | `unpublished:true`; source, history and data survive. Use-level starts are disabled. |
| Inspect before App deletion | `code_manage_read({id})` | `id,title,revision,publishedVersion,storageRevision,files,kv,databaseConnected,managementRevision`. |
| Delete App entirely | `code_delete({id,expectedManagementRevision})` | `deleted:true,databaseCleanupQueued`; removes source history, publications, grants, and shared data. This cannot be undone. |

Forward the exact opaque revisions from the corresponding read. A concurrent
source, storage, grant, or database change invalidates App-deletion review.
Database writes invalidate earlier database reviews even when their outcome is
uncertain. File versions change across deletion and recreation of the same key.

For JSON reads/writes or structured record/schema edits, use the existing
[Storage](storage.md) or [Database](database.md) methods in a temporary
`code_run({code,resourceId})` run. This requires Manage and leaves App source
unchanged. Do not add maintenance controls to the user's dashboard just to
perform an agent task. Database state belongs to the App across sessions;
source restore never rolls back its data.
