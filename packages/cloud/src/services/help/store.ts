import { type SQL, sql } from "bun";
import { APP_REGISTRY_TTL_MS } from "../../_internal/registry";
import type { HelpCorpus, HelpMetadata } from "./types";

// One expired app lease of grace after an app can no longer be discovered.
export const HELP_RETENTION_MS = APP_REGISTRY_TTL_MS * 2;
export const HELP_RESOURCE_PAGE_SIZE = 100;
const searchConfigs = ["english", "german", "simple"] as const;

export const migrateHelp = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud:help:migrate'))`;
    await tx`CREATE SCHEMA IF NOT EXISTS help`.simple();
    await tx`CREATE TABLE IF NOT EXISTS help.corpora (
    app_id text NOT NULL, manifest_hash text NOT NULL, base_locale text NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, manifest_hash)
  )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS help_expiry_idx ON help.corpora(last_seen_at)`.simple();
    await tx`CREATE TABLE IF NOT EXISTS help.documents (
    app_id text NOT NULL, manifest_hash text NOT NULL, locale text NOT NULL, document_id text NOT NULL,
    title text NOT NULL, description text, icon text, sort_order integer NOT NULL,
    markdown text NOT NULL, search_text text NOT NULL, search_config text NOT NULL,
    search_document tsvector NOT NULL,
    PRIMARY KEY (app_id, manifest_hash, locale, document_id),
    FOREIGN KEY (app_id, manifest_hash) REFERENCES help.corpora ON DELETE CASCADE
  )`.simple();
    await tx`CREATE INDEX IF NOT EXISTS help_search_idx ON help.documents USING gin(search_document)`.simple();
  });
  // The operator enables the extension; Help never installs server extensions.
  const [extension] = await db<{ installed: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') AS installed`;
  if (extension?.installed) {
    try {
      for (const config of searchConfigs) {
        await db
          .unsafe(`CREATE INDEX IF NOT EXISTS help_bm25_${config}_idx ON help.documents
        USING bm25(search_text) WITH (text_config='${config}') WHERE search_config='${config}'`)
          .simple();
      }
    } catch (error) {
      console.warn("Optional Help BM25 indexes unavailable; native search remains active", error);
    }
  }
};

/** Commit the complete source once; subsequent app heartbeats only renew its lease. */
export const registerHelp = async (corpus: HelpCorpus, db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '10s'`.simple();
    const renewed = await tx`UPDATE help.corpora SET last_seen_at = clock_timestamp()
      WHERE app_id = ${corpus.appId} AND manifest_hash = ${corpus.manifestHash} RETURNING app_id`;
    if (renewed.length) return;
    const inserted = await tx`INSERT INTO help.corpora(app_id, manifest_hash, base_locale)
      VALUES (${corpus.appId}, ${corpus.manifestHash}, ${corpus.baseLocale})
      ON CONFLICT (app_id, manifest_hash) DO UPDATE SET last_seen_at = clock_timestamp()
      RETURNING (xmax = 0) AS inserted`;
    if (!inserted[0]?.inserted) return;
    for (const [locale, documents] of [[corpus.baseLocale, corpus.documents] as const, ...Object.entries(corpus.documentsByLocale)]) {
      const config = locale.split("-")[0] === "de" ? "german" : locale.split("-")[0] === "en" ? "english" : "simple";
      // One bounded article per statement; no duplicate whole-corpus JSON transport.
      for (const document of documents) {
        const text = `${document.title}\n${document.description ?? ""}\n${document.searchText}`;
        await tx`INSERT INTO help.documents(app_id, manifest_hash, locale, document_id, title, description, icon,
          sort_order, markdown, search_text, search_config, search_document)
          VALUES (${corpus.appId}, ${corpus.manifestHash}, ${locale}, ${document.id}, ${document.title},
            ${document.description ?? null}, ${document.icon ?? null}, ${document.order}, ${document.markdown}, ${text}, ${config},
            setweight(to_tsvector(${config}::regconfig, ${document.id + " " + document.title}), 'A') ||
            setweight(to_tsvector(${config}::regconfig, ${document.description ?? ""}), 'B') ||
            setweight(to_tsvector(${config}::regconfig, ${document.searchText}), 'D'))`;
      }
    }
  });
};

/** Row locks serialize cleanup with publication/renewal. Delete at most one corpus per tick. */
export const cleanupHelp = async (db: SQL = sql): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '10s'`.simple();
    await tx`DELETE FROM help.corpora WHERE (app_id, manifest_hash) IN (
    SELECT app_id, manifest_hash FROM help.corpora
    WHERE last_seen_at < now() - ${HELP_RETENTION_MS} * interval '1 millisecond'
    ORDER BY last_seen_at LIMIT 1 FOR UPDATE SKIP LOCKED
  )`;
  });
};

export type HelpSelection = { app_id: string; app_name: string; manifest_hash: string; locales: string[] };
type Row = {
  app_id: string;
  app_name: string;
  manifest_hash: string;
  locale: string;
  document_id: string;
  title: string;
  description: string | null;
  icon: string | null;
  sort_order: number;
  markdown?: string;
};
export const metadata = (row: Row): HelpMetadata => ({
  appId: row.app_id,
  appName: row.app_name,
  manifestHash: row.manifest_hash,
  locale: row.locale,
  documentId: row.document_id,
  title: row.title,
  description: row.description ?? undefined,
  icon: row.icon ?? undefined,
  order: row.sort_order,
});

export const hasHelpBm25 = async (db: SQL = sql): Promise<boolean> => {
  const [row] = await db<{ ready: boolean }[]>`SELECT
    EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_textsearch') AND
    (SELECT count(*) = 3 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am a ON a.oid=c.relam
      WHERE c.oid IN (to_regclass('help.help_bm25_english_idx'), to_regclass('help.help_bm25_german_idx'),
        to_regclass('help.help_bm25_simple_idx')) AND i.indisvalid AND a.amname='bm25') AS ready`;
  return row?.ready === true;
};

/** Locale precedence is applied before matching, ranking and limiting, including partial translations. */
export const queryHelp = async (
  selection: HelpSelection[],
  input: {
    query?: string;
    documentId?: string;
    body?: boolean;
    limit?: number;
    cursor?: string;
    bm25?: boolean;
  },
  db: SQL = sql,
): Promise<Row[]> => {
  if (!selection.length) return [];
  const ranked = input.query !== undefined;
  const nativeRank = `ts_rank_cd(d.search_document, websearch_to_tsquery(d.search_config::regconfig, $2))`;
  const bm25Rank = `CASE d.search_config ${searchConfigs
    .map((config) => `WHEN '${config}' THEN d.search_text <@> to_bm25query($2, 'help.help_bm25_${config}_idx')`)
    .join(" ")} END`;
  const matching = searchConfigs
    .map((config) => `(d.search_config='${config}' AND d.search_document @@ websearch_to_tsquery('${config}', $2))`)
    .join(" OR ");
  const pending = db.unsafe<Row[]>(
    `WITH active AS (
    SELECT * FROM jsonb_to_recordset(($1::text)::jsonb) AS a(app_id text, app_name text, manifest_hash text, locales text[])
  ) SELECT d.app_id, a.app_name, d.manifest_hash, d.locale, d.document_id, d.title, d.description, d.icon, d.sort_order
    ${input.body ? ", d.markdown" : ""}
    FROM help.documents d JOIN active a ON a.app_id=d.app_id AND a.manifest_hash=d.manifest_hash
    WHERE length($2::text) >= 0 AND d.locale=ANY(a.locales)
      AND NOT EXISTS (SELECT 1 FROM help.documents preferred
        WHERE preferred.app_id=d.app_id AND preferred.manifest_hash=d.manifest_hash AND preferred.document_id=d.document_id
          AND preferred.locale=ANY(a.locales) AND array_position(a.locales, preferred.locale)<array_position(a.locales, d.locale))
      AND ($3::text IS NULL OR d.document_id=$3)
      AND ($4::text IS NULL OR ('cloud://help/' || d.app_id || '/' || d.document_id) COLLATE "C" > $4)
      ${ranked ? `AND (lower(d.document_id)=lower($2) OR lower(d.title)=lower($2) OR ${matching})` : ""}
    ORDER BY ${
      ranked
        ? `(lower(d.document_id)=lower($2) OR lower(d.title)=lower($2)) DESC,
      ${input.bm25 ? bm25Rank + " ASC," : ""} ${nativeRank} DESC,`
        : ""
    }
      d.app_id COLLATE "C", ${input.cursor !== undefined ? "" : "d.sort_order,"} d.document_id COLLATE "C"
    ${input.limit !== undefined ? "LIMIT $5" : ""}`,
    [
      JSON.stringify(selection),
      input.query ?? "",
      input.documentId ?? null,
      input.cursor ?? null,
      ...(input.limit !== undefined ? [input.limit] : []),
    ],
  );
  // Match the app publication write deadline and bound abandoned reads at the driver.
  const timeout = setTimeout(() => pending.cancel(), 10_000);
  try {
    return await pending;
  } finally {
    clearTimeout(timeout);
  }
};
