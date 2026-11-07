### Photo edits must keep their source and upload identity

- **What happened:** Adding photo editing to Files can overwrite a newer file if the editor exports from a changing URL or reuses the first revision after saving. Retrying an unconfirmed write with a new export can also publish a different snapshot.
- **Root cause:** Source bytes, expected revision, captured editor entry, and the storage receipt have distinct lifetimes.
- **Error class:** Mutable input snapshots and ambiguous write completion.
- **Guard:** Files photo-editing browser guards open the actual preview dialog and shared editor with deterministic storage responses. They check no source refetch during repeated saves, revision advancement, retained edits after a conflict, copy-only destinations, supported encoders, guarded dismissal and canvas disposal, decode failure, output above the library default at the actual encoder, and manual reconciliation using identical upload metadata while later edits stay dirty. The existing upload adapter retains the durable upload key.
