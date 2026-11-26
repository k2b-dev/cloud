import { sql } from "@k2b/cloud";
import { toPgTextArray } from "@k2b/cloud/services";

export type ListingFactTarget = { path: string; target: string; itemId: string | null; directory: boolean };
export type ListingFactRow = { path: string; author_id: string | null; links: number };
export type ListingFactsInput = {
  bindingId: string;
  root: string;
  basePath: string;
  serverUrl: string;
  userId: string;
  history: boolean;
  items: ListingFactTarget[];
};

/** One statement per Filegate page; neither activity nor link readers run once per entry. */
export function readListingFacts(input: ListingFactsInput) {
  return sql<ListingFactRow[]>`WITH page AS (
    SELECT * FROM unnest(
      ${toPgTextArray(input.items.map((item) => item.path))}::text[],
      ${toPgTextArray(input.items.map((item) => item.target))}::text[],
      ${toPgTextArray(input.items.map((item) => item.itemId ?? ""))}::text[],
      ${toPgTextArray(input.items.map((item) => String(item.directory)))}::boolean[]
    ) AS entry(path,target,item_id,directory)
  )
  SELECT page.path, author.actor_user_id AS author_id, links.count::integer AS links
  FROM page
  LEFT JOIN LATERAL (
    -- Separate branches keep the stable-ID and (root,left(path_after,400)) indexes usable.
    SELECT a.actor_user_id FROM (
      SELECT * FROM filesv2.activity
      WHERE page.item_id<>'' AND item_after_id=page.item_id
      UNION ALL
      SELECT * FROM filesv2.activity
      WHERE page.item_id='' AND root=${input.root}
        AND left(path_after,400)=left(page.target,400) AND path_after=page.target
    ) a
    WHERE ${input.history} AND a.state='done' AND a.actor_kind='user'
      AND a.action IN ('file.create','file.upload','file.overwrite','file.edit','version.restore')
      AND a.server_url=${input.serverUrl}
      AND coalesce(a.base_after_id,a.base_id)=${input.bindingId}::uuid
      AND coalesce(a.root_after,a.root)=${input.root}
    ORDER BY coalesce(a.finished_at,a.started_at) DESC,a.id DESC LIMIT 1
  ) author ON true
  LEFT JOIN LATERAL (
    SELECT count(*) FROM filesv2.shares s
    WHERE s.created_by=${input.userId}::uuid AND s.kind='download'
      AND s.base_id=${input.bindingId}::uuid AND s.root=${input.root} AND s.base_path=${input.basePath}
      AND (s.server_url IS NULL OR s.server_url=${input.serverUrl})
      AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
      AND (EXISTS (
        SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.target_snapshots)='array'
          THEN s.target_snapshots ELSE '[]'::jsonb END) AS snapshot(value)
        WHERE snapshot.value->'directory'=to_jsonb(page.directory)
          AND jsonb_typeof(snapshot.value->'path')='string'
          AND jsonb_typeof(snapshot.value->'itemId') IN ('string','null')
          AND CASE WHEN page.item_id<>'' AND snapshot.value->>'itemId' IS NOT NULL
            THEN snapshot.value->>'itemId'=page.item_id ELSE snapshot.value->>'path'=page.target END
      ) OR ((s.target_snapshots IS NULL OR s.target_snapshots='null'::jsonb)
        AND s.items @> jsonb_build_array(page.path)))
  ) links ON true`;
}
