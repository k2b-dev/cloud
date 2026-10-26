import { sql } from "bun";

/** Open inline comments of one note, for Book's quiet "n comments" entry; the caller has authorized reading the note. */
export const countOpenAnnotations = async (noteId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM notebooks.annotations
    WHERE note_id = ${noteId}::uuid AND deleted_at IS NULL AND state = 'open'`;
  return row?.count ?? 0;
};
