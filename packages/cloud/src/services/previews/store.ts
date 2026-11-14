import { createHash } from "node:crypto";
import type { SQL, TransactionSQL } from "bun";
import { ensureSchema } from "../postgres";
import type { PreviewManifest, PreviewSource, PreviewState } from "./types";

export const previewHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const previewJobKey = (source: PreviewSource) => previewHash(JSON.stringify([source.key, source.revision]));
export const previewObjectKey = (keyHash: string, revision: string, variant: string) =>
  `previews/${keyHash}/${previewHash(revision)}/${variant}`;
export type PreviewRow = {
  key_hash: string;
  revision: string;
  state: PreviewState;
  bytes: number;
  variants: PreviewManifest;
  shown_at: Date;
  created_at: Date;
  error_code: string | null;
};
export const PREVIEW_CLEANUP_BATCH = 100;
/** How long a failed, too large or unsupported revision is remembered. */
export const PREVIEW_TERMINAL_RETENTION_DAYS = 30;

export async function setupPreviews(db: SQL): Promise<void> {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.previews'))`;
    await ensureSchema(tx, "platform");
    const [existing] = await tx<
      { present: boolean; indexed: boolean }[]
    >`SELECT to_regclass('platform._cloud_previews') IS NOT NULL AS present, to_regclass('platform._cloud_previews_shown') IS NOT NULL AS indexed`;
    if (!existing?.present)
      await tx`CREATE TABLE IF NOT EXISTS platform._cloud_previews (
      package text NOT NULL, key_hash text NOT NULL, revision text NOT NULL,
      state text NOT NULL CHECK (state IN ('ready', 'failed', 'too_large', 'unsupported')),
      bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0), variants jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
      shown_at timestamptz NOT NULL DEFAULT statement_timestamp(), error_code text,
      PRIMARY KEY (package, key_hash, revision)
    )`.simple();
    if (!existing?.indexed)
      await tx`CREATE INDEX IF NOT EXISTS _cloud_previews_shown ON platform._cloud_previews (shown_at, package, key_hash, revision)`.simple();
  });
}

export interface PreviewStore {
  find(source: PreviewSource): Promise<PreviewRow | null>;
  put(source: PreviewSource, state: PreviewState, variants?: PreviewManifest, errorCode?: string): Promise<void>;
  shown(source: PreviewSource): Promise<void>;
  retry(source: PreviewSource): Promise<void>;
  rows(keyHash: string): Promise<PreviewRow[]>;
  remove(row: Pick<PreviewRow, "key_hash" | "revision">): Promise<void>;
  eviction(maxBytes: number): Promise<PreviewRow[]>;
  /** Removes up to one batch of this package's remembered failures and refusals that are older than their retention. */
  expireTerminal(): Promise<number>;
  withKey<T>(keyHash: string, run: (store: PreviewStore) => Promise<T>): Promise<{ value: T } | null>;
}

/** Every mutation is package-bound. Only the eviction calculation reads the installation's aggregate. */
export function createPreviewsStore(db: SQL, packageName: string): PreviewStore {
  const scoped = (query: SQL | TransactionSQL): PreviewStore => ({
    async find(source) {
      const [row] = await query<
        PreviewRow[]
      >`SELECT * FROM platform._cloud_previews WHERE package=${packageName} AND key_hash=${previewHash(source.key)} AND revision=${source.revision}`;
      return row ?? null;
    },
    async put(source, state, variants = {}, errorCode) {
      const bytes = Object.values(variants).reduce((total, item) => total + item.bytes, 0);
      await query`INSERT INTO platform._cloud_previews (package, key_hash, revision, state, bytes, variants, error_code)
        VALUES (${packageName}, ${previewHash(source.key)}, ${source.revision}, ${state}, ${bytes}, ${JSON.stringify(variants)}::text::jsonb, ${errorCode ?? null})
        ON CONFLICT (package, key_hash, revision) DO UPDATE SET state=EXCLUDED.state, bytes=EXCLUDED.bytes, variants=EXCLUDED.variants, error_code=EXCLUDED.error_code`;
    },
    async shown(source) {
      await query`UPDATE platform._cloud_previews SET shown_at=statement_timestamp()
        WHERE package=${packageName} AND key_hash=${previewHash(source.key)} AND revision=${source.revision}
        AND shown_at < statement_timestamp() - interval '1 day'`;
    },
    async retry(source) {
      await query`DELETE FROM platform._cloud_previews WHERE package=${packageName} AND key_hash=${previewHash(source.key)} AND revision=${source.revision} AND state='failed'`;
    },
    rows: (keyHash) =>
      query<
        PreviewRow[]
      >`SELECT * FROM platform._cloud_previews WHERE package=${packageName} AND key_hash=${keyHash} ORDER BY revision LIMIT ${PREVIEW_CLEANUP_BATCH}`,
    async remove(row) {
      await query`DELETE FROM platform._cloud_previews WHERE package=${packageName} AND key_hash=${row.key_hash} AND revision=${row.revision}`;
    },
    eviction: (maxBytes) => query<PreviewRow[]>`WITH ranked AS (
      SELECT *, SUM(bytes) OVER (ORDER BY shown_at DESC, package DESC, key_hash DESC, revision DESC ROWS UNBOUNDED PRECEDING) AS retained
      FROM platform._cloud_previews WHERE bytes > 0
    ) SELECT * FROM ranked WHERE retained > ${maxBytes} AND package=${packageName}
      ORDER BY shown_at, key_hash, revision LIMIT ${PREVIEW_CLEANUP_BATCH}`,
    async expireTerminal() {
      // A failure stays remembered for its revision long enough that a broken file is not drawn again on every view;
      // after that a later view tries once more. These rows hold no bytes, so the byte budget never removes them.
      const removed = await query<{ key_hash: string }[]>`DELETE FROM platform._cloud_previews
        WHERE (package, key_hash, revision) IN (
          SELECT package, key_hash, revision FROM platform._cloud_previews
          WHERE package=${packageName} AND state <> 'ready' AND created_at < statement_timestamp() - ${PREVIEW_TERMINAL_RETENTION_DAYS} * interval '1 day'
          LIMIT ${PREVIEW_CLEANUP_BATCH})
        RETURNING key_hash`;
      return removed.length;
    },
    async withKey(keyHash, run) {
      // Serialize all revisions, generation, retry and deletion for one application object.
      return db.begin(async (tx) => {
        const [lock] = await tx<
          { acquired: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${packageName}:${keyHash}`}, 0)) AS acquired`;
        if (!lock?.acquired) return null;
        return { value: await run(scoped(tx)) };
      });
    },
  });
  return scoped(db);
}
