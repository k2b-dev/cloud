import { sql } from "@k2b/cloud";
import type { FileProviderEntry, FileProviderListData } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { z } from "zod";
import { mailCapabilityMessages } from "../capability-messages";
import { getMailboxAccess, isCurrentActorActive, type MailboxAccess, messageVisibleTo } from "./access";
import { capByCredentialScopes, type MailRequestContext, personalPrincipal } from "./auth";
import { readableMailboxes } from "./focus";

type SqlFragment = Bun.SQL.Query<unknown>;

/**
 * The Mail file source over `mail.attachment_files` (see `attachment-file-index.ts`): mailboxes › years › months ›
 * senders › files. Folder IDs are paths of the mailbox's public ID, year, month and sender; files are attachment IDs,
 * which `attachment.content.read` opens with the same access rule.
 */
const MAILBOX = "[0-9A-Za-z]{6}";
const FOLDER = new RegExp(`^(${MAILBOX})(?:/(\\d{4})(?:/(0[1-9]|1[0-2])(?:/(-|e:[^/]{1,1024}))?)?)?$`);
const UNKNOWN_SENDER = "-";

type Folder =
  | { level: "mailbox"; mailbox: string }
  | { level: "year"; mailbox: string; year: number }
  | { level: "month"; mailbox: string; year: number; month: number }
  | { level: "sender"; mailbox: string; year: number; month: number; sender: string };

const parseFolder = (id: string): Folder | null => {
  const match = FOLDER.exec(id);
  if (!match) return null;
  const [, mailbox = "", year, month, sender] = match;
  if (!year) return { level: "mailbox", mailbox };
  if (!month) return { level: "year", mailbox, year: Number(year) };
  if (!sender) return { level: "month", mailbox, year: Number(year), month: Number(month) };
  if (sender === UNKNOWN_SENDER) return { level: "sender", mailbox, year: Number(year), month: Number(month), sender: "" };
  try {
    return { level: "sender", mailbox, year: Number(year), month: Number(month), sender: decodeURIComponent(sender.slice(2)) };
  } catch {
    return null;
  }
};

const pad = (value: number) => String(value).padStart(2, "0");
const yearId = (mailbox: string, year: number) => `${mailbox}/${year}`;
const monthId = (mailbox: string, year: number, month: number) => `${yearId(mailbox, year)}/${pad(month)}`;
const senderId = (mailbox: string, year: number, month: number, sender: string) =>
  `${monthId(mailbox, year, month)}/${sender ? `e:${encodeURIComponent(sender)}` : UNKNOWN_SENDER}`;

/**
 * The chooser cleans every name again; the provider keeps names inside the contract by the same rule: no control
 * characters, path separators or bidi controls, at most 255 characters with the extension kept, never empty.
 */
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f/\\؜‎‏‪-‮⁦-⁩]/g;
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

/** The Mail list's rule for a row: a message the reader may see that still lies in a folder. */
const visibleFile = (access: MailboxAccess) => sql`
  ${messageVisibleTo(access, sql`f.message_id`)}
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
  const shown = rows.slice(0, input.limit);
  const last = shown.at(-1);
  return ok(
    page(
      shown.map((row) => ({ kind: "folder" as const, id: row.short_id, name: providerName(row.label, row.short_id) })),
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
  const before = cursor.data?.year ?? null;
  const rows = await sql<{ year: number; latest: Date }[]>`
    SELECT extract(year FROM f.month)::int AS year, max(f.internal_date) AS latest
    FROM mail.attachment_files f
    WHERE f.mailbox_id = ${mailboxId}::uuid
      AND (${before}::int IS NULL OR f.month < make_date(${before}::int, 1, 1))
      AND ${visibleFile(access)}
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT ${input.limit + 1}
  `;
  const shown = rows.slice(0, input.limit);
  const last = shown.at(-1);
  return ok(
    page(
      shown
        .filter((row) => query === null || String(row.year).includes(query))
        .map((row) => ({ kind: "folder" as const, id: yearId(mailbox, row.year), name: String(row.year), updatedAt: iso(row.latest) })),
      rows.length > input.limit && last ? JSON.stringify({ year: last.year }) : null,
    ),
  );
};

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
  const before = cursor.data?.month ?? null;
  const rows = await sql<{ month: number; latest: Date }[]>`
    SELECT extract(month FROM f.month)::int AS month, max(f.internal_date) AS latest
    FROM mail.attachment_files f
    WHERE f.mailbox_id = ${mailboxId}::uuid
      AND f.month >= make_date(${folder.year}::int, 1, 1)
      AND f.month < CASE WHEN ${before}::int IS NULL THEN make_date(${folder.year}::int + 1, 1, 1)
        ELSE make_date(${folder.year}::int, ${before}::int, 1) END
      AND ${visibleFile(access)}
    GROUP BY f.month
    ORDER BY f.month DESC
    LIMIT ${input.limit + 1}
  `;
  const shown = rows.slice(0, input.limit);
  const last = shown.at(-1);
  return ok(
    page(
      shown
        .map((row) => ({
          kind: "folder" as const,
          id: monthId(folder.mailbox, folder.year, row.month),
          name: t.attachmentMonth({ month: row.month }),
          updatedAt: iso(row.latest),
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
  const rows = await sql<{ sender_email: string; sender_name: string | null; latest: Date }[]>`
    SELECT f.sender_email,
      (array_agg(f.sender_name ORDER BY f.internal_date DESC) FILTER (WHERE f.sender_name IS NOT NULL))[1] AS sender_name,
      max(f.internal_date) AS latest
    FROM mail.attachment_files f
    WHERE f.mailbox_id = ${mailboxId}::uuid
      AND f.month = make_date(${folder.year}::int, ${folder.month}::int, 1)
      AND (${after}::text IS NULL OR f.sender_email > ${after}::text)
      AND (${query}::text IS NULL OR ${contains(sql`f.sender_email`, query)} OR ${contains(sql`COALESCE(f.sender_name, '')`, query)})
      AND ${visibleFile(access)}
    GROUP BY f.sender_email
    ORDER BY f.sender_email
    LIMIT ${input.limit + 1}
  `;
  const shown = rows.slice(0, input.limit);
  const last = shown.at(-1);
  return ok(
    page(
      shown.map((row) => ({
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
  const rows = await sql<
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
    SELECT f.attachment_id, a.short_id, f.filename, f.size_bytes, f.content_type, f.internal_date,
      -- Microseconds, so the cursor never falls between two rows of one millisecond.
      to_char(f.internal_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS position
    FROM mail.attachment_files f
    JOIN mail.attachments a ON a.id = f.attachment_id
    WHERE f.mailbox_id = ${mailboxId}::uuid
      AND f.month = make_date(${folder.year}::int, ${folder.month}::int, 1)
      AND f.sender_email = ${folder.sender}
      AND ${contains(sql`COALESCE(f.filename, '')`, query)}
      AND (${cursor.data?.at ?? null}::timestamptz IS NULL
        OR (f.internal_date, f.attachment_id) < (${cursor.data?.at ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid))
      AND ${visibleFile(access)}
    ORDER BY f.internal_date DESC, f.attachment_id DESC
    LIMIT ${input.limit + 1}
  `;
  const shown = rows.slice(0, input.limit);
  const last = shown.at(-1);
  return ok(
    page(
      shown.map((row) => {
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
