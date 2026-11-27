import { createHash } from "node:crypto";
import { sql } from "@k2b/cloud";
import type { FileProviderEntry, FileProviderListData } from "@k2b/cloud/contracts";
import { toPgTextArray } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import { IMAGE_PREVIEW_CONTENT_TYPES, MIN_LIST_IMAGE_BYTES } from "../attachment-preview-policy";
import { mailCapabilityMessages } from "../capability-messages";
import { MAX_DRAFT_ATTACHMENT_BYTES } from "../contracts";
import { getMailboxAccess, isCurrentActorActive, type MailboxAccess } from "./access";
import { capByCredentialScopes, type MailRequestContext, personalPrincipal } from "./auth";
import { readableMailboxes } from "./focus";

type SqlFragment = Bun.SQL.Query<unknown>;

/**
 * The Mail file source over `mail.attachment_files` (see `attachment-file-index.ts`): mailboxes › years › months ›
 * senders › files. Folder IDs are paths of the mailbox's public ID, year, month and sender; files are attachment IDs,
 * which `attachment.content.read` opens with the same access rule.
 */
const MAILBOX = "[0-9A-Za-z]{6}";
// A sender's address is header text of up to 320 characters; encoded, it can outgrow the contract's 2,048-character IDs.
// Short ones stay readable in the ID, longer ones go by their SHA-256, which the files query compares within the month.
const SENDER_IN_ID = 512;
const FOLDER = new RegExp(`^(${MAILBOX})(?:/((?!0000)\\d{4})(?:/(0[1-9]|1[0-2])(?:/(-|e:[^/]{1,${SENDER_IN_ID}}|h:[0-9a-f]{64}))?)?)?$`);
const UNKNOWN_SENDER = "-";

type Folder =
  | { level: "mailbox"; mailbox: string }
  | { level: "year"; mailbox: string; year: number }
  | { level: "month"; mailbox: string; year: number; month: number }
  | { level: "sender"; mailbox: string; year: number; month: number; sender: { email: string } | { hash: string } };

const parseFolder = (id: string): Folder | null => {
  const match = FOLDER.exec(id);
  if (!match) return null;
  const [, mailbox = "", year, month, sender] = match;
  if (!year) return { level: "mailbox", mailbox };
  if (!month) return { level: "year", mailbox, year: Number(year) };
  if (!sender) return { level: "month", mailbox, year: Number(year), month: Number(month) };
  const at = { level: "sender" as const, mailbox, year: Number(year), month: Number(month) };
  if (sender === UNKNOWN_SENDER) return { ...at, sender: { email: "" } };
  if (sender.startsWith("h:")) return { ...at, sender: { hash: sender.slice(2) } };
  try {
    return { ...at, sender: { email: decodeURIComponent(sender.slice(2)) } };
  } catch {
    return null;
  }
};

const pad = (value: number) => String(value).padStart(2, "0");
const yearId = (mailbox: string, year: number) => `${mailbox}/${String(year).padStart(4, "0")}`;
const monthId = (mailbox: string, year: number, month: number) => `${yearId(mailbox, year)}/${pad(month)}`;
const senderKey = (sender: string) => {
  if (!sender) return UNKNOWN_SENDER;
  const encoded = encodeURIComponent(sender);
  return encoded.length <= SENDER_IN_ID ? `e:${encoded}` : `h:${createHash("sha256").update(sender, "utf8").digest("hex")}`;
};
const senderId = (mailbox: string, year: number, month: number, sender: string) => `${monthId(mailbox, year, month)}/${senderKey(sender)}`;

/**
 * Names within the contract: no control characters, path separators or bidi controls (the chooser's set), at most the
 * contract's 255 characters (UTF-16 code units) with the extension kept, never empty. The chooser cleans each name
 * again and also cuts it to 255 UTF-8 bytes.
 */
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f/\\\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
export const providerName = (value: string | null, fallback: string): string => {
  const cleaned = (value ?? "").replace(UNSAFE_NAME_CHARACTERS, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return fallback;
  if (cleaned.length <= 255) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 32 ? cleaned.slice(dot) : "";
  let stem = "";
  // Whole code points only, so a cut never leaves half a character.
  for (const character of cleaned.slice(0, cleaned.length - extension.length)) {
    if (stem.length + character.length + extension.length > 255) break;
    stem += character;
  }
  return `${stem.trimEnd()}${extension}`;
};

const mediaType = (value: string): string | undefined => {
  const type = value.trim();
  return /^[\x20-\x7e]{1,255}$/.test(type) ? type : undefined;
};

const contains = (column: SqlFragment, query: string | null) =>
  query === null ? sql`true` : sql`strpos(lower(${column}), lower(${query})) > 0`;

/**
 * The rows a folder reads, as `f`. A reader of the whole mailbox walks the folder index. An assigned-only reader
 * starts from their conversations (assignee index, conversation links, `attachment_files_message_idx`): the Mail list's
 * `messageVisibleTo` rule, driven from the small side, so a large shared mailbox costs their attachments, not its rows.
 */
const scopedFiles = (mailboxId: string, access: MailboxAccess) =>
  access.scope === "mailbox"
    ? { with: sql``, from: sql`mail.attachment_files f`, mailbox: sql`f.mailbox_id = ${mailboxId}::uuid` }
    : {
        with: sql`WITH assigned_files AS MATERIALIZED (
          SELECT DISTINCT ON (f.attachment_id) f.*
          FROM mail.conversation_assignees assignee
          JOIN mail.conversation_messages link ON link.conversation_id = assignee.conversation_id
          JOIN mail.attachment_files f ON f.message_id = link.message_id
          WHERE assignee.principal_id = ${access.userId ?? access.serviceAccountId}::uuid
            AND f.mailbox_id = ${mailboxId}::uuid
          ORDER BY f.attachment_id
        )`,
        from: sql`assigned_files f`,
        mailbox: sql`true`,
      };

/**
 * What the source shows of an indexed attachment, decided when it reads: not an inline part the body references by
 * Content-ID (inline photos and PDFs from Apple Mail stay), not a preview-format image (JPEG, PNG, GIF, WebP) under the
 * list's signature-logo threshold, nothing `attachment.content.read` refuses as too large, and only mail that still lies
 * in a folder, like the Mail list.
 */
const shown = () => sql`
  NOT (f.disposition = 'inline' AND f.body_references)
  AND NOT (
    lower(btrim(split_part(f.content_type, ';', 1))) = ANY(${toPgTextArray([...IMAGE_PREVIEW_CONTENT_TYPES])}::text[])
    AND f.size_bytes < ${MIN_LIST_IMAGE_BYTES}
  )
  AND f.size_bytes <= ${MAX_DRAFT_ATTACHMENT_BYTES}
  AND EXISTS (
    SELECT 1 FROM mail.message_placements placement
    WHERE placement.message_id = f.message_id AND placement.deleted_at IS NULL
  )
`;

const iso = (value: Date | string) => new Date(value).toISOString();

const RootCursor = z.object({ key: z.string().max(400), id: z.string().regex(new RegExp(`^${MAILBOX}$`)) }).strict();
const YearCursor = z.object({ year: z.number().int().min(1).max(9999) }).strict();
const MonthCursor = z.object({ month: z.number().int().min(1).max(12) }).strict();
const SenderCursor = z.object({ sender: z.string().max(1024) }).strict();
const FileCursor = z.object({ at: z.string().datetime({ offset: true }), id: z.uuid() }).strict();

const readCursor = <T extends z.ZodType>(schema: T, cursor: string | undefined): Result<z.output<T> | null> => {
  if (cursor === undefined) return ok(null);
  try {
    const parsed = schema.safeParse(JSON.parse(cursor));
    if (parsed.success) return ok(parsed.data);
  } catch {
    // An unreadable cursor is answered like any other one that does not fit.
  }
  return fail(err.badInput("Invalid cursor"));
};

export type AttachmentFileListInput = { parent?: string; query?: string; cursor?: string; limit: number };

/**
 * One page of the Mail file source. Every folder is one bounded query over the index after the access check, with at
 * most `limit` entries and a keyset cursor; years and months filter their few labels after it.
 */
export const listAttachmentFiles = async (
  context: MailRequestContext,
  input: AttachmentFileListInput,
  locale: string,
): Promise<Result<FileProviderListData>> => {
  const query = input.query?.trim() || null;
  if (input.parent === undefined) return listMailboxFolders(context, input, query);
  const folder = parseFolder(input.parent);
  if (!folder) return fail(err.notFound("Folder"));
  const [mailbox] = await sql<{ id: string }[]>`
    SELECT id FROM mail.mailboxes WHERE short_id = ${folder.mailbox} AND deleted_at IS NULL
  `;
  if (!mailbox) return fail(err.notFound("Folder"));
  const access = await getMailboxAccess(context, mailbox.id);
  if (!access) return fail(err.notFound("Folder"));
  const t = mailCapabilityMessages(locale);
  if (folder.level === "mailbox") return listYears(mailbox.id, folder.mailbox, access, input, query);
  if (folder.level === "year") return listMonths(mailbox.id, folder, access, input, query, t);
  if (folder.level === "month") return listSenders(mailbox.id, folder, access, input, query, t);
  return listFiles(mailbox.id, folder, access, input, query, t);
};

const page = (items: FileProviderEntry[], next: string | null): FileProviderListData => ({ writable: false, items, next });

/** The mailboxes the reader may see and has not hidden, named by their address, in address order. */
const listMailboxFolders = async (
  context: MailRequestContext,
  input: AttachmentFileListInput,
  query: string | null,
): Promise<Result<FileProviderListData>> => {
  const cursor = readCursor(RootCursor, input.cursor);
  if (!cursor.ok) return cursor;
  if (capByCredentialScopes(context, "read") !== "read" || !(await isCurrentActorActive(context))) return ok(page([], null));
  const principal = personalPrincipal(context);
  const principalMatches =
    principal.kind === "user"
      ? sql`preference.user_id = ${principal.id}::uuid`
      : sql`preference.user_id IS NULL AND preference.service_account_id = ${principal.id}::uuid`;
  const rows = await sql<{ short_id: string; label: string; key: string }[]>`
    SELECT m.short_id, labelled.label, labelled.key
    FROM (${readableMailboxes(context)}) readable
    JOIN mail.mailboxes m ON m.id = readable.mailbox_id AND m.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT connection.email FROM mail.provider_connections connection
      WHERE connection.owner_mailbox_id = m.id AND connection.status <> 'revoked'
      ORDER BY connection.created_at, connection.id
      LIMIT 1
    ) address ON true
    CROSS JOIN LATERAL (
      SELECT COALESCE(address.email, m.name) AS label, lower(COALESCE(address.email, m.name)) AS key
    ) labelled
    WHERE NOT EXISTS (
        SELECT 1 FROM mail.personal_mailbox_preferences preference
        WHERE preference.mailbox_id = m.id AND preference.hidden_at IS NOT NULL AND ${principalMatches}
      )
      AND ${contains(sql`labelled.label`, query)}
      AND (${cursor.data?.key ?? null}::text IS NULL OR (labelled.key, m.short_id) > (${cursor.data?.key ?? null}::text, ${cursor.data?.id ?? null}::text))
    ORDER BY labelled.key, m.short_id
    LIMIT ${input.limit + 1}
  `;
  const listed = rows.slice(0, input.limit);
  const last = listed.at(-1);
  return ok(
    page(
      listed.map((row) => ({ kind: "folder" as const, id: row.short_id, name: providerName(row.label, row.short_id) })),
      rows.length > input.limit && last ? JSON.stringify({ key: last.key, id: last.short_id }) : null,
    ),
  );
};

const listYears = async (
  mailboxId: string,
  mailbox: string,
  access: MailboxAccess,
  input: AttachmentFileListInput,
  query: string | null,
): Promise<Result<FileProviderListData>> => {
  const cursor = readCursor(YearCursor, input.cursor);
  if (!cursor.ok) return cursor;
  const before = cursor.data ? `${String(cursor.data.year).padStart(4, "0")}-01-01` : "infinity";
  const rows = await monthsWithFiles(mailboxId, access, { from: "-infinity", before, step: "year", limit: input.limit });
  const listed = rows.slice(0, input.limit);
  const last = listed.at(-1);
  return ok(
    page(
      listed
        .filter((row) => query === null || String(row.year).includes(query))
        .map((row) => ({ kind: "folder" as const, id: yearId(mailbox, row.year), name: String(row.year) })),
      rows.length > input.limit && last ? JSON.stringify({ year: last.year }) : null,
    ),
  );
};

type MonthRange = { from: string; before: string; step: "year" | "month"; limit: number };

/**
 * The newest months below `before` that hold a file the reader may see, one per year or per month, at most
 * `limit + 1`. For the whole mailbox a loose index scan: each step is one descent of the folder index below the
 * previous hit, so years of attachments cost one step per year or month. For an assigned-only reader, the distinct
 * months of their own attachments.
 */
const monthsQuery = (mailboxId: string, access: MailboxAccess, range: MonthRange) => {
  if (access.scope !== "mailbox") {
    const scope = scopedFiles(mailboxId, access);
    const bucket = range.step === "year" ? sql`date_trunc('year', f.month)::date` : sql`f.month`;
    return sql<{ year: number; month: number }[]>`
      ${scope.with}
      SELECT extract(year FROM picked.month)::int AS year, extract(month FROM picked.month)::int AS month
      FROM (
        SELECT DISTINCT ${bucket} AS month
        FROM ${scope.from}
        WHERE f.month >= ${range.from}::date AND f.month < ${range.before}::date AND ${shown()}
      ) picked
      ORDER BY picked.month DESC
      LIMIT ${range.limit + 1}
    `;
  }
  const below = range.step === "year" ? sql`date_trunc('year', found.month)::date` : sql`found.month`;
  return sql<{ year: number; month: number }[]>`
    WITH RECURSIVE found AS (
      (
        SELECT f.month, 1 AS depth
        FROM mail.attachment_files f
        WHERE f.mailbox_id = ${mailboxId}::uuid AND f.month >= ${range.from}::date AND f.month < ${range.before}::date
          AND ${shown()}
        ORDER BY f.month DESC
        LIMIT 1
      )
      UNION ALL
      SELECT (
        SELECT f.month
        FROM mail.attachment_files f
        WHERE f.mailbox_id = ${mailboxId}::uuid AND f.month >= ${range.from}::date AND f.month < ${below}
          AND ${shown()}
        ORDER BY f.month DESC
        LIMIT 1
      ), found.depth + 1
      FROM found
      WHERE found.month IS NOT NULL AND found.depth <= ${range.limit}
    )
    SELECT extract(year FROM month)::int AS year, extract(month FROM month)::int AS month
    FROM found
    WHERE month IS NOT NULL
    ORDER BY found.month DESC
  `;
};

const monthsWithFiles = async (mailboxId: string, access: MailboxAccess, range: MonthRange) => await monthsQuery(mailboxId, access, range);

type Messages = ReturnType<typeof mailCapabilityMessages>;

const listMonths = async (
  mailboxId: string,
  folder: Extract<Folder, { level: "year" }>,
  access: MailboxAccess,
  input: AttachmentFileListInput,
  query: string | null,
  t: Messages,
): Promise<Result<FileProviderListData>> => {
  const cursor = readCursor(MonthCursor, input.cursor);
  if (!cursor.ok) return cursor;
  const year = String(folder.year).padStart(4, "0");
  const before = cursor.data ? `${year}-${pad(cursor.data.month)}-01` : `${String(folder.year + 1).padStart(4, "0")}-01-01`;
  const rows = await monthsWithFiles(mailboxId, access, { from: `${year}-01-01`, before, step: "month", limit: input.limit });
  const listed = rows.slice(0, input.limit);
  const last = listed.at(-1);
  return ok(
    page(
      listed
        .map((row) => ({
          kind: "folder" as const,
          id: monthId(folder.mailbox, folder.year, row.month),
          name: t.attachmentMonth({ month: row.month }),
        }))
        .filter((entry) => query === null || entry.name.toLowerCase().includes(query.toLowerCase())),
      rows.length > input.limit && last ? JSON.stringify({ month: last.month }) : null,
    ),
  );
};

const listSenders = async (
  mailboxId: string,
  folder: Extract<Folder, { level: "month" }>,
  access: MailboxAccess,
  input: AttachmentFileListInput,
  query: string | null,
  t: Messages,
): Promise<Result<FileProviderListData>> => {
  const cursor = readCursor(SenderCursor, input.cursor);
  if (!cursor.ok) return cursor;
  const after = cursor.data?.sender ?? null;
  const rows = await sendersQuery(mailboxId, access, { year: folder.year, month: folder.month, after, query, limit: input.limit });
  const listed = rows.slice(0, input.limit);
  const last = listed.at(-1);
  return ok(
    page(
      listed.map((row) => ({
        kind: "folder" as const,
        id: senderId(folder.mailbox, folder.year, folder.month, row.sender_email),
        name: providerName(
          row.sender_email === "" ? null : row.sender_name ? `${row.sender_name} (${row.sender_email})` : row.sender_email,
          t.unknownSender,
        ),
        updatedAt: iso(row.latest),
      })),
      rows.length > input.limit && last ? JSON.stringify({ sender: last.sender_email }) : null,
    ),
  );
};

const listFiles = async (
  mailboxId: string,
  folder: Extract<Folder, { level: "sender" }>,
  access: MailboxAccess,
  input: AttachmentFileListInput,
  query: string | null,
  t: Messages,
): Promise<Result<FileProviderListData>> => {
  const cursor = readCursor(FileCursor, input.cursor);
  if (!cursor.ok) return cursor;
  const rows = await filesQuery(mailboxId, access, {
    year: folder.year,
    month: folder.month,
    sender: folder.sender,
    query,
    cursor: cursor.data,
    limit: input.limit,
  });
  const listed = rows.slice(0, input.limit);
  const last = listed.at(-1);
  return ok(
    page(
      listed.map((row) => {
        const type = mediaType(row.content_type);
        return {
          kind: "file" as const,
          id: row.short_id,
          name: providerName(row.filename, t.unnamedAttachment),
          size: Number(row.size_bytes),
          ...(type ? { mediaType: type } : {}),
          updatedAt: iso(row.internal_date),
        };
      }),
      rows.length > input.limit && last ? JSON.stringify({ at: last.position, id: last.attachment_id }) : null,
    ),
  );
};

type SenderPage = { year: number; month: number; after: string | null; query: string | null; limit: number };

/** One month's senders in address order, with their newest display name: one group over that month's rows. */
const sendersQuery = (mailboxId: string, access: MailboxAccess, at: SenderPage) => {
  const scope = scopedFiles(mailboxId, access);
  return sql<{ sender_email: string; sender_name: string | null; latest: Date }[]>`
    ${scope.with}
    SELECT f.sender_email,
      (array_agg(f.sender_name ORDER BY f.internal_date DESC) FILTER (WHERE f.sender_name IS NOT NULL))[1] AS sender_name,
      max(f.internal_date) AS latest
    FROM ${scope.from}
    WHERE ${scope.mailbox}
      AND f.month = make_date(${at.year}::int, ${at.month}::int, 1)
      AND (${at.after}::text IS NULL OR f.sender_email > ${at.after}::text)
      AND (${at.query}::text IS NULL OR ${contains(sql`f.sender_email`, at.query)} OR ${contains(sql`COALESCE(f.sender_name, '')`, at.query)})
      AND ${shown()}
    GROUP BY f.sender_email
    ORDER BY f.sender_email
    LIMIT ${at.limit + 1}
  `;
};

type FilePage = {
  year: number;
  month: number;
  sender: { email: string } | { hash: string };
  query: string | null;
  cursor: { at: string; id: string } | null;
  limit: number;
};

/** One sender's files of a month, newest first, by keyset; a hashed sender is compared within the month. */
const filesQuery = (mailboxId: string, access: MailboxAccess, at: FilePage) => {
  const scope = scopedFiles(mailboxId, access);
  const sender =
    "hash" in at.sender
      ? sql`encode(sha256(convert_to(f.sender_email, 'UTF8')), 'hex') = ${at.sender.hash}`
      : sql`f.sender_email = ${at.sender.email}`;
  return sql<
    {
      attachment_id: string;
      short_id: string;
      filename: string | null;
      size_bytes: string | number;
      content_type: string;
      internal_date: Date;
      position: string;
    }[]
  >`
    ${scope.with}
    SELECT f.attachment_id, a.short_id, f.filename, f.size_bytes, f.content_type, f.internal_date,
      -- Microseconds, so the cursor never falls between two rows of one millisecond.
      to_char(f.internal_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position
    FROM ${scope.from}
    JOIN mail.attachments a ON a.id = f.attachment_id
    WHERE ${scope.mailbox}
      AND f.month = make_date(${at.year}::int, ${at.month}::int, 1)
      AND ${sender}
      AND ${contains(sql`COALESCE(f.filename, '')`, at.query)}
      AND (${at.cursor?.at ?? null}::timestamptz IS NULL
        OR (f.internal_date, f.attachment_id) < (${at.cursor?.at ?? null}::timestamptz, ${at.cursor?.id ?? null}::uuid))
      AND ${shown()}
    ORDER BY f.internal_date DESC, f.attachment_id DESC
    LIMIT ${at.limit + 1}
  `;
};

/** The folder queries, unexecuted, so tests can read their plans. */
export const attachmentFileQueries = { months: monthsQuery, senders: sendersQuery, files: filesQuery };
