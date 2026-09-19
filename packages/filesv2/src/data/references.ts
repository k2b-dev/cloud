import { createHash } from "node:crypto";
import { sql } from "bun";
import { entryRefId, parseEntryRefId } from "../resource-ref";

/** Inline refs remain directly resolvable; long paths receive a bounded durable resource identity. */
export async function persistedEntryRefId(baseId: string, path: string): Promise<string> {
  const inline = entryRefId(baseId, path);
  if (inline) return inline;
  const id = `p:${createHash("sha256")
    .update(JSON.stringify([baseId, path]))
    .digest("hex")}`;
  const rows = await sql<{ id: string }[]>`INSERT INTO filesv2.entry_references(id,base_id,path) VALUES(${id},${baseId},${path})
    ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id WHERE entry_references.base_id=EXCLUDED.base_id AND entry_references.path=EXCLUDED.path RETURNING id`;
  if (!rows.length) throw new Error("Resource reference collision");
  return id;
}

export async function resolveEntryRefId(id: string): Promise<{ baseId: string; path: string } | null> {
  if (!/^p:[a-f0-9]{64}$/.test(id)) return parseEntryRefId(id);
  const row = (await sql<{ base_id: string; path: string }[]>`SELECT base_id,path FROM filesv2.entry_references WHERE id=${id}`)[0];
  return row ? { baseId: row.base_id, path: row.path } : null;
}
