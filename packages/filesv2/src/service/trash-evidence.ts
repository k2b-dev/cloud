import type { Node } from "@k2b/filegate";

/**
 * Same conservative fingerprint as directory lifecycle; no claim of atomic CAS.
 * Filegate 7 publishes node ids only on stable-id roots, so journal snapshots
 * from older daemons may carry an id the current node lacks.
 */
export const sameTrashNode = (before: Node | null, after: Node) =>
  before !== null &&
  before.directory === after.directory &&
  before.uid === after.uid &&
  before.gid === after.gid &&
  before.mode === after.mode &&
  (before.id && after.id ? before.id === after.id : before.modified === after.modified && before.size === after.size);
