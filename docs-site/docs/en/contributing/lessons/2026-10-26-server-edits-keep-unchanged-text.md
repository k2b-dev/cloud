### Server edits discarded unchanged text identities

- **What happened:** Editing two distant passages through the server collapsed relative positions in the unchanged text between them and disrupted concurrent edits there. Restoring a version in place used the same path.
- **Root cause:** The shared-text edit path applied one prefix/suffix replacement, deleting and reinserting the entire span between the first and last change.
- **Error class:** Whole-span replacement destroys CRDT identity.
- **Guard:** The shared-text integration test checks paragraph anchors and a concurrent middle insertion after replay. The Notebooks integration test checks that restoring a version in place preserves an anchor in unchanged text. Diff property tests check exact text and surrogate boundaries, including budget fallback.
