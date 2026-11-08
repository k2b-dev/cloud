### Optional search fields must preserve historical schema recognition

- **What happened:** Adding optional search grouping caused Core to discard search Queries from older, intact manifests.
- **Root cause:** Historical schema hashes were derived from the current result schema, so the new optional property changed every historical candidate too.
- **Error class:** Schema evolution changes a compatibility fixture instead of preserving the released wire shape.
- **Guard:** The frozen previous-release Files manifest remains byte-for-byte unchanged. Capability compilation checks preserve historical manifest, schema and data hashes; the pre-format hash stays fixed. Resource-view tests also require an unset group to remain absent.
