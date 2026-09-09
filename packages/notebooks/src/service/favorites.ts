import type { MutationResult } from "@k2b/cloud/contracts";
import { sql } from "bun";
import { noteFavoriteChanged } from "./workspace-events";

export type FavoriteNoteId = {
  noteId: string;
  createdAt: string;
};

export const listIds = async (params: { notebookId: string; userId: string }): Promise<FavoriteNoteId[]> => {
  const rows = await sql<{ note_id: string; created_at: Date }[]>`
    SELECT n.short_id AS note_id, f.created_at
    FROM notebooks.note_favorites f
    JOIN notebooks.notes n ON n.id = f.note_id
    WHERE f.notebook_id = ${params.notebookId}::uuid
      AND f.user_id = ${params.userId}::uuid
    ORDER BY f.created_at DESC
  `;
  return rows.map((row) => ({ noteId: row.note_id, createdAt: row.created_at.toISOString() }));
};

export const isFavorite = async (params: { noteId: string; userId: string }): Promise<boolean> => {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM notebooks.note_favorites
      WHERE note_id = ${params.noteId}::uuid
        AND user_id = ${params.userId}::uuid
    ) AS exists
  `;
  return row?.exists ?? false;
};

export const setFavorite = async (params: {
  notebookId: string;
  noteId: string;
  userId: string;
  favorite: boolean;
}): Promise<MutationResult<{ favorite: boolean }>> => {
  if (params.favorite) {
    await sql`
      INSERT INTO notebooks.note_favorites (user_id, notebook_id, note_id)
      VALUES (${params.userId}::uuid, ${params.notebookId}::uuid, ${params.noteId}::uuid)
      ON CONFLICT (user_id, note_id) DO NOTHING
    `;
  } else {
    await sql`
      DELETE FROM notebooks.note_favorites
      WHERE user_id = ${params.userId}::uuid
        AND note_id = ${params.noteId}::uuid
    `;
  }

  await noteFavoriteChanged(params);
  return { ok: true, data: { favorite: params.favorite } };
};
