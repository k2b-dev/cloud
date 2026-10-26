### Replacing text moved a peer's insertion inside the replacement

- **What happened:** The Mail model regression produced `P peerROJECT notes` when a peer added text after `Project` and another writer changed it to `PROJECT`.
- **Root cause:** Deleting the original range before inserting its replacement discarded the replacement's right-edge anchor and let writer ordering decide where the peer text appeared.
- **Error class:** A collaborative replacement loses its original insertion boundary.
- **Guard:** Replacement inserts before deleting the original range. Model tests cover revision and local subject edits with fixed peer identities on either side of the writer's ordering.
