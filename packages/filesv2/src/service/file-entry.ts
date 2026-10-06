import type { Node } from "@k2b/filegate";
import type { BaseSummary, FileEntry } from "../contracts";
import { stableEntryRefId } from "../resource-ref";

/**
 * The one place a stable ref is minted: a base on a root with Filegate stable IDs and a node Filegate has
 * identified. Everything else keeps path refs, per entry, so a node without an ID still gets one.
 */
export function fileEntry(base: Pick<BaseSummary, "id" | "stableIds">, relative: string, node: Node): FileEntry {
  const resourceId = base.stableIds && node.id ? stableEntryRefId(base.id, node.id) : null;
  return {
    name: relative.split("/").at(-1)!,
    path: relative,
    directory: node.directory,
    size: node.size,
    modified: node.modified,
    revision: node.revision,
    ...(resourceId ? { resourceId } : {}),
  };
}
