import { sql } from "@k2b/cloud";
import { backgroundWork, logger, startRuntimeInterval, toPgTextArray } from "@k2b/cloud/services";
import { toPgUuidArray } from "@k2b/cloud/services/postgres";

type SqlClient = typeof sql;
type SqlFragment = Bun.SQL.Query<unknown>;

/**
 * Mail offers its attachments to the shared file chooser as one read-only source. This index holds one row per stored
 * attachment with the facts every folder reads: mailbox, date, sender, file facts, and what decides whether a person
 * picks it (disposition, Content-ID, whether the body references it). The source filters when it reads
 * (`attachment-files.ts`), so a changed rule needs no reindex. Rows follow their attachment (`ON DELETE CASCADE`), so
 * hydration, which replaces a message's attachments, replaces their rows too. Months are UTC: capabilities know no
 * person's time zone, and a stored bucket needs one zone. Every statement is idempotent and runs on each start.
 */
export const migrateAttachmentFiles = async (db: SqlClient): Promise<void> => {
  await db`
    CREATE TABLE IF NOT EXISTS mail.attachment_files (
      attachment_id uuid PRIMARY KEY REFERENCES mail.attachments(id) ON DELETE CASCADE,
      mailbox_id uuid NOT NULL,
      message_id uuid NOT NULL,
      internal_date timestamptz NOT NULL,
      month date GENERATED ALWAYS AS ((date_trunc('month', internal_date AT TIME ZONE 'UTC'))::date) STORED,
      sender_email text NOT NULL,
      sender_name text,
      filename text,
      size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
      content_type text NOT NULL,
      blob_id uuid NOT NULL,
      disposition text,
      content_id text,
      body_references boolean NOT NULL,
      link_domains text[] NOT NULL
    )
  `.simple();
  // Years, months and senders group in this order; a sender's files read it newest first.
  await db`
    CREATE INDEX IF NOT EXISTS attachment_files_folder_idx
    ON mail.attachment_files (mailbox_id, month DESC, sender_email, internal_date DESC, attachment_id DESC)
  `.simple();
  // An assigned-only reader starts from their conversations' messages; a message whose date moves updates by message.
  await db`CREATE INDEX IF NOT EXISTS attachment_files_message_idx ON mail.attachment_files (message_id)`.simple();
  await db`
    CREATE TABLE IF NOT EXISTS mail.attachment_files_backfill (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      after_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
      indexed bigint NOT NULL DEFAULT 0,
      completed_at timestamptz
    )
  `.simple();
  // A sync that moves a message's date moves its rows. A row trigger rather than the sync statement itself: its query
  // runs after the message row lock with a fresh snapshot, so it also sees rows that hydration or the backfill committed
  // while the sync waited for that lock, which the waiting statement's own snapshot would miss.
  await db`CREATE OR REPLACE FUNCTION mail.move_attachment_file_dates() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE mail.attachment_files SET internal_date = NEW.internal_date
      WHERE message_id = NEW.id AND internal_date IS DISTINCT FROM NEW.internal_date;
      RETURN NULL;
    END; $$`.simple();
  // Created once: replacing it on every start would take a table lock on every message write.
  await db`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'mail.message_contents'::regclass
      AND tgname = 'message_contents_attachment_file_dates') THEN
      CREATE TRIGGER message_contents_attachment_file_dates AFTER UPDATE OF internal_date ON mail.message_contents
        FOR EACH ROW WHEN (OLD.internal_date IS DISTINCT FROM NEW.internal_date)
        EXECUTE FUNCTION mail.move_attachment_file_dates();
    END IF;
  END $$`.simple();
};

/**
 * One statement: the index rows of the attachments that `attachments` selects (a subquery of `id`), with
 * `bodyReferences` a boolean over `a` and `mc` that says whether the message body shows the part through its
 * Content-ID.
 */
const insertAttachmentFiles = (db: SqlClient, attachments: SqlFragment, bodyReferences: SqlFragment, linkDomains: SqlFragment) => db<
  { attachment_id: string }[]
>`
  INSERT INTO mail.attachment_files (
    attachment_id, mailbox_id, message_id, internal_date, sender_email, sender_name,
    filename, size_bytes, content_type, blob_id, disposition, content_id, body_references, link_domains
  )
  SELECT a.id, mc.mailbox_id, mc.id, mc.internal_date, COALESCE(sender.normalized_email, ''),
    NULLIF(btrim(sender.display_name), ''), a.filename, a.size_bytes, a.content_type, a.blob_id, a.disposition, a.content_id,
    COALESCE(${bodyReferences}, false), COALESCE(${linkDomains}, ARRAY[]::text[])
  FROM mail.attachments a
  JOIN mail.message_contents mc ON mc.id = a.message_id
  LEFT JOIN LATERAL (
    SELECT address.normalized_email, address.display_name
    FROM mail.message_addresses address
    WHERE address.message_id = mc.id AND address.role = 'from'
    ORDER BY address.position
    LIMIT 1
  ) sender ON true
  WHERE a.id IN (${attachments})
  ON CONFLICT (attachment_id) DO NOTHING
  RETURNING attachment_id
`;

/**
 * Ingest calls this in the transaction that stores the message, after its attachments and addresses. The caller
 * passes the stored Content-IDs the body shows, decided by the reader's rule (`bodyReferencedContentIds`).
 */
export const indexMessageAttachments = async (
  db: SqlClient,
  messageId: string,
  body: { contentIds: readonly string[]; linkDomains: readonly string[] },
): Promise<void> => {
  await insertAttachmentFiles(
    db,
    sql`SELECT id FROM mail.attachments WHERE message_id = ${messageId}::uuid`,
    sql`a.content_id = ANY(${toPgTextArray([...body.contentIds])}::text[])`,
    sql`${toPgTextArray([...body.linkDomains])}::text[]`,
  );
};

/**
 * The backfill reads the stored HTML in SQL, where the reader's percent-decoding is not at hand: an image source
 * `src="cid:…"` matches its normalized Content-ID followed by the closing quote, as is or with `@` written `%40`.
 * A `cid:` link in `href` does not count, as in the reader.
 */
const storedBodyReferences = () => {
  const id = sql`lower(regexp_replace(btrim(a.content_id, E' \t\r\n'), '^<|>$', '', 'g'))`;
  return sql`CASE WHEN a.content_id IS NULL OR mc.sanitized_html IS NULL THEN false ELSE (
    SELECT length(${id}) > 0 AND (
      strpos(body.html, 'src="cid:' || ${id} || '"') > 0
      OR strpos(body.html, 'src="cid:' || replace(${id}, '@', '%40') || '"') > 0
    )
    FROM (SELECT lower(mc.sanitized_html) AS html) body
  ) END`;
};

/**
 * The stored body's link domains in SQL, for the backfill: the lower-case host of each `<a href="http(s)://…">`,
 * without user info and a trailing dot. Ingest uses the assessment's own parser (`messageLinkDomains`).
 */
const storedLinkDomains = () => sql`ARRAY(
  SELECT DISTINCT rtrim(link[1], '.')
  FROM regexp_matches(lower(COALESCE(mc.sanitized_html, '')), '<a[[:space:]][^>]*href=["'']https?://(?:[^/"''?#@]*@)?([a-z0-9.-]+)', 'g') AS link
)`;

/** One statement: lock one batch without waiting, and say where its cursor may move. */
const lockBackfillBatch = (db: SqlClient, afterId: string) => db<
  { scanned: number; last_id: string | null; below_skipped: string | null; skipped: boolean; locked: string }[]
>`
  WITH candidates AS (
    SELECT id FROM mail.attachments WHERE id > ${afterId}::uuid ORDER BY id LIMIT ${ATTACHMENT_FILES_BACKFILL_BATCH}
  ), locked AS (
    SELECT a.id
    FROM mail.attachments a
    JOIN mail.message_contents mc ON mc.id = a.message_id
    WHERE a.id IN (SELECT id FROM candidates)
    FOR KEY SHARE OF a SKIP LOCKED
    FOR SHARE OF mc SKIP LOCKED
  ), first_skipped AS (
    SELECT c.id FROM candidates c WHERE c.id NOT IN (SELECT id FROM locked) ORDER BY c.id LIMIT 1
  )
  SELECT (SELECT count(*) FROM candidates)::int AS scanned,
    (SELECT id FROM candidates ORDER BY id DESC LIMIT 1) AS last_id,
    (SELECT c.id FROM candidates c WHERE c.id < (SELECT id FROM first_skipped) ORDER BY c.id DESC LIMIT 1) AS below_skipped,
    EXISTS (SELECT 1 FROM first_skipped) AS skipped,
    COALESCE((SELECT string_agg(id::text, ',') FROM locked), '') AS locked
`;

/** One statement: index already stored attachments (a subquery of `id`), reading their bodies in SQL. */
export const indexStoredAttachments = (db: SqlClient, attachments: SqlFragment) =>
  insertAttachmentFiles(db, attachments, storedBodyReferences(), storedLinkDomains());

/** One statement, after the batch is locked: index the locked attachments from a fresh snapshot. */
const indexBackfillBatch = (db: SqlClient, ids: readonly string[]) =>
  indexStoredAttachments(db, sql`SELECT unnest(${toPgUuidArray([...ids])}::uuid[])`);

/** The two batch steps, for tests that hold a transaction between them. */
export const attachmentFileBackfillSteps = { lock: lockBackfillBatch, index: indexBackfillBatch };

// Match the existing startup migrations' 100-row transaction budget (shared drafts, reply drafts).
export const ATTACHMENT_FILES_BACKFILL_BATCH = 100;
// Lets ingest's transactions in between batches; one million attachments add 10,000 × 50 ms = 500 s of pauses.
const BACKFILL_PAUSE_MS = 50;
const BACKFILL_INTERVAL_MS = 10 * 60_000;
const log = logger("mail:attachment-files");

export type AttachmentFileBackfill = { afterId: string; indexed: number; completed: boolean };

/**
 * Indexes the attachments stored before the index existed, one batch per transaction in attachment order. The cursor
 * commits with each batch, so a crash or another process resumes after finished work, and rows ingest already wrote
 * stay as they are.
 *
 * A batch first locks what it reads, in its own statement and without waiting: its attachments `FOR KEY SHARE`, their
 * messages `FOR SHARE`, both `SKIP LOCKED`. A delete (hydration's replacement, a purge) or a sync that moves the
 * message's date holds one of them, so waiting could deadlock with a cascade that locks in another order. The insert
 * then runs as the next statement, with a snapshot taken after the locks: a date move that committed before them is
 * read, and one that comes after waits for the batch and then moves its rows (the date trigger). A skipped attachment
 * stays ahead of the cursor, which stops just below the first one, so a delete that rolls back loses nothing. A batch
 * that moves nothing ends the run; the next one retries after the interval. In maintenance „Ruhe“ it stops between
 * batches and answers `null` before the first.
 */
export const backfillAttachmentFiles = async (signal?: AbortSignal): Promise<AttachmentFileBackfill | null> => {
  let progress: AttachmentFileBackfill | null = null;
  for (;;) {
    signal?.throwIfAborted();
    if (backgroundWork.paused()) return progress;
    const step = await sql.begin(async (tx): Promise<AttachmentFileBackfill & { moved: boolean }> => {
      await tx`SET LOCAL lock_timeout = '10s'`;
      await tx`INSERT INTO mail.attachment_files_backfill (singleton) VALUES (true) ON CONFLICT DO NOTHING`;
      const [marker] = await tx<{ after_id: string; indexed: string | number; completed_at: Date | null }[]>`
        SELECT after_id, indexed, completed_at FROM mail.attachment_files_backfill WHERE singleton FOR UPDATE
      `;
      if (!marker) throw new Error("Attachment file backfill marker is missing");
      if (marker.completed_at) return { afterId: marker.after_id, indexed: Number(marker.indexed), completed: true, moved: false };
      const [batch] = await lockBackfillBatch(tx, marker.after_id);
      const locked = batch?.locked ? batch.locked.split(",") : [];
      const indexed = locked.length > 0 ? (await indexBackfillBatch(tx, locked)).length : 0;
      const scanned = batch?.scanned ?? 0;
      const skipped = batch?.skipped === true;
      const afterId = (skipped ? batch?.below_skipped : batch?.last_id) ?? marker.after_id;
      const next = {
        afterId,
        indexed: Number(marker.indexed) + indexed,
        completed: !skipped && scanned < ATTACHMENT_FILES_BACKFILL_BATCH,
        moved: afterId !== marker.after_id,
      };
      await tx`
        UPDATE mail.attachment_files_backfill
        SET after_id = ${next.afterId}::uuid, indexed = ${next.indexed},
          completed_at = CASE WHEN ${next.completed} THEN now() ELSE NULL END
        WHERE singleton
      `;
      return next;
    });
    progress = { afterId: step.afterId, indexed: step.indexed, completed: step.completed };
    if (step.completed || !step.moved) return progress;
    await Bun.sleep(BACKFILL_PAUSE_MS);
  }
};

let backfill: { stop(): Promise<void> } | undefined;

/** Runs the backfill after start and again after a failure, a stalled batch or maintenance „Ruhe“; once finished, a run is one read. */
export const startAttachmentFileBackfill = (): void => {
  backfill ??= startRuntimeInterval({
    intervalMs: BACKFILL_INTERVAL_MS,
    run: async (signal) => {
      const progress = await backfillAttachmentFiles(signal);
      if (progress?.completed) log.debug("Mail attachment file index is complete", progress);
    },
    onError: (error) => log.warn("Mail attachment file backfill paused; the next run resumes it", { error: String(error) }),
  });
};

export const stopAttachmentFileBackfill = async (): Promise<void> => {
  const running = backfill;
  backfill = undefined;
  await running?.stop();
};
