import { sql } from "@k2b/cloud";
import { buildPreview } from "./tags";

/**
 * The notebook's pages as one list a person filters: all of them, their favorites, the ones with a tag, and a search in
 * titles and text. It replaces the tag page (`/tags/:tag`). Two statements per page, as the tag page had: the page of
 * rows and its count. Favorites and tags start from their own indexed rows, so a filter costs its matches.
 */

export type PageListSort = "updated" | "created" | "title";

export type PageListEntry = {
  shortId: string;
  title: string;
  preview: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
};

const ORDER: Record<PageListSort, string> = {
  updated: "n.updated_at DESC, n.title, n.short_id",
  created: "n.created_at DESC, n.title, n.short_id",
  title: "lower(n.title), n.short_id",
};

export const listPages = async (params: {
  notebookId: string;
  userId: string;
  /** `true`: only the person's favorites; `false`: none of them; absent: all. */
  favorite: boolean | undefined;
  tag: string | null;
  search: string | null;
  sort: PageListSort;
  offset: number;
  limit: number;
}): Promise<{ items: PageListEntry[]; total: number }> => {
  const query = params.search?.trim().toLowerCase();
  const pattern = query ? `%${query}%` : null;
  const source =
    params.favorite === true
      ? sql`notebooks.note_favorites f JOIN notebooks.notes n ON n.id = f.note_id
        WHERE f.user_id = ${params.userId}::uuid AND f.notebook_id = ${params.notebookId}::uuid`
      : sql`notebooks.notes n WHERE n.notebook_id = ${params.notebookId}::uuid`;
  const condition = sql`
    ${
      params.tag
        ? sql`AND EXISTS (SELECT 1 FROM notebooks.note_tags t WHERE t.note_id = n.id AND t.tag = ${params.tag.toLowerCase()})`
        : sql``
    }
    ${
      params.favorite === false
        ? sql`AND NOT EXISTS (SELECT 1 FROM notebooks.note_favorites nf WHERE nf.note_id = n.id AND nf.user_id = ${params.userId}::uuid)`
        : sql``
    }
    ${pattern ? sql`AND (LOWER(n.title) LIKE ${pattern} OR LOWER(n.content_md) LIKE ${pattern})` : sql``}
  `;
  const order = sql.unsafe(ORDER[params.sort]);
  const rows = await sql<
    {
      short_id: string;
      title: string;
      content_md: string | null;
      created_at: Date;
      updated_at: Date;
      locked_at: Date | null;
      tags: string[];
    }[]
  >`
    WITH page AS MATERIALIZED (
      SELECT n.id, n.short_id, n.title, n.content_md, n.created_at, n.updated_at, n.locked_at
      FROM ${source} ${condition}
      ORDER BY ${order}
      LIMIT ${params.limit} OFFSET ${params.offset}
    )
    SELECT n.short_id, n.title, n.content_md, n.created_at, n.updated_at, n.locked_at,
      ARRAY(SELECT nt.tag FROM notebooks.note_tags nt WHERE nt.note_id = n.id ORDER BY nt.tag) AS tags
    FROM page n
    ORDER BY ${order}
  `;
  const [count] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM ${source} ${condition}`;
  return {
    total: count?.count ?? 0,
    items: rows.map((row) => ({
      shortId: row.short_id,
      title: row.title,
      preview: buildPreview(row.content_md),
      tags: row.tags,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      lockedAt: row.locked_at?.toISOString() ?? null,
    })),
  };
};
