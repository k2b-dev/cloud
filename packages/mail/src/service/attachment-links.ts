import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { audit, coreSettings } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import type {
  AttachmentLink,
  AttachmentLinkPage,
  CreateAttachmentLinkInput as CreateAttachmentLinkRequest,
  CreatedAttachmentLink,
} from "../contracts";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext } from "./auth";
import type { AttachmentDownload } from "./messages";

export const MAX_ATTACHMENT_LINK_FILE_BYTES = 100 * 1024 * 1024;

const PUBLIC_TOKEN_BYTES = 32;
const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const MIN_PASSWORD_BYTES = 8;
const MAX_PASSWORD_BYTES = 256;
const MAX_DOWNLOAD_LIMIT = 1_000_000;
const attachmentLinkCursorSchema = z.object({ version: z.literal(1), createdAt: z.string().datetime(), id: z.string().uuid() }).strict();

type AttachmentLinkCursor = z.infer<typeof attachmentLinkCursorSchema>;

const encodeAttachmentLinkCursor = (cursor: AttachmentLinkCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeAttachmentLinkCursor = (value?: string): Result<AttachmentLinkCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = attachmentLinkCursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? ok(parsed.data) : fail(err.badInput("Invalid pagination cursor"));
  } catch {
    return fail(err.badInput("Invalid pagination cursor"));
  }
};

export type AttachmentLinkSnapshot = Readonly<{
  tokenHash: string;
  passwordHash: string | null;
  fileSizeBytes: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  downloadCount: number;
  maxDownloads: number | null;
}>;

export type CreateAttachmentLinkInput = Readonly<{
  fileSizeBytes: number;
  now: Date;
  password?: string | null;
  expiresAt?: Date | null;
  maxDownloads?: number | null;
}>;

export type CreateAttachmentLinkResult =
  | Readonly<{
      ok: true;
      publicToken: string;
      persistent: AttachmentLinkSnapshot;
    }>
  | Readonly<{
      ok: false;
      code: "invalid_file_size" | "invalid_time" | "invalid_expiry" | "invalid_password" | "invalid_download_limit";
    }>;

export type AttachmentLinkDownloadDecision =
  | Readonly<{ ok: true; nextDownloadCount: number }>
  | Readonly<{ ok: false; code: "unavailable" }>;

const unavailable: AttachmentLinkDownloadDecision = Object.freeze({ ok: false, code: "unavailable" });

const isValidDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());

const isValidFileSize = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ATTACHMENT_LINK_FILE_BYTES;

const isValidDownloadCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < Number.MAX_SAFE_INTEGER;

const isValidMaxDownloads = (value: unknown): value is number | null =>
  value === null || (Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_DOWNLOAD_LIMIT);

const isValidPassword = (value: unknown): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") >= MIN_PASSWORD_BYTES &&
  Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES;

const tokenMatches = (publicToken: unknown, tokenHash: unknown): boolean => {
  if (typeof publicToken !== "string" || typeof tokenHash !== "string") return false;
  if (!PUBLIC_TOKEN_PATTERN.test(publicToken) || !TOKEN_HASH_PATTERN.test(tokenHash)) return false;
  const actual = Buffer.from(hashAttachmentLinkToken(publicToken), "hex");
  const expected = Buffer.from(tokenHash, "hex");
  return timingSafeEqual(actual, expected);
};

export const hashAttachmentLinkToken = (publicToken: string): string => createHash("sha256").update(publicToken).digest("hex");

export const createAttachmentLink = async (input: CreateAttachmentLinkInput): Promise<CreateAttachmentLinkResult> => {
  if (!isValidFileSize(input.fileSizeBytes)) return { ok: false, code: "invalid_file_size" };
  if (!isValidDate(input.now)) return { ok: false, code: "invalid_time" };

  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (!isValidDate(expiresAt) || expiresAt.getTime() <= input.now.getTime())) {
    return { ok: false, code: "invalid_expiry" };
  }

  const maxDownloads = input.maxDownloads ?? null;
  if (!isValidMaxDownloads(maxDownloads)) return { ok: false, code: "invalid_download_limit" };

  const password = input.password ?? null;
  if (password !== null && !isValidPassword(password)) {
    return { ok: false, code: "invalid_password" };
  }

  const publicToken = randomBytes(PUBLIC_TOKEN_BYTES).toString("base64url");
  const passwordHash = password === null ? null : await Bun.password.hash(password, "argon2id");
  return {
    ok: true,
    publicToken,
    persistent: {
      tokenHash: hashAttachmentLinkToken(publicToken),
      passwordHash,
      fileSizeBytes: input.fileSizeBytes,
      expiresAt,
      revokedAt: null,
      downloadCount: 0,
      maxDownloads,
    },
  };
};

export const decideAttachmentLinkDownload = async (input: {
  link: AttachmentLinkSnapshot;
  publicToken: string;
  password?: string | null;
  now: Date;
}): Promise<AttachmentLinkDownloadDecision> => {
  const { link } = input;
  if (!isValidDate(input.now) || !tokenMatches(input.publicToken, link.tokenHash)) return unavailable;
  if (!isValidFileSize(link.fileSizeBytes) || !isValidDownloadCount(link.downloadCount)) return unavailable;
  if (!isValidMaxDownloads(link.maxDownloads)) return unavailable;
  if (link.expiresAt !== null && !isValidDate(link.expiresAt)) return unavailable;
  if (link.revokedAt !== null && !isValidDate(link.revokedAt)) return unavailable;
  if (link.revokedAt !== null || (link.expiresAt !== null && input.now.getTime() >= link.expiresAt.getTime())) return unavailable;
  if (link.maxDownloads !== null && link.downloadCount >= link.maxDownloads) return unavailable;

  if (link.passwordHash !== null) {
    if (typeof link.passwordHash !== "string" || link.passwordHash.length === 0 || !isValidPassword(input.password)) {
      return unavailable;
    }
    try {
      if (!(await Bun.password.verify(input.password, link.passwordHash))) return unavailable;
    } catch {
      return unavailable;
    }
  }

  // Persistence must claim this count atomically against the validated snapshot before streaming bytes.
  return { ok: true, nextDownloadCount: link.downloadCount + 1 };
};

type DbAttachmentLink = {
  id: string;
  mailbox_id: string;
  blob_id: string | null;
  source_kind: AttachmentLink["sourceKind"];
  source_id: string;
  filename: string | null;
  content_type: string;
  byte_length: string | number;
  token_hash: string;
  password_hash: string | null;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  download_count: string | number;
  max_downloads: string | number | null;
  last_downloaded_at: Date | string | null;
  created_at: Date | string;
};

const linkColumns = sql`
  link.id,
  link.mailbox_id,
  link.blob_id,
  link.source_kind,
  link.source_id,
  link.filename,
  link.content_type,
  link.byte_length,
  link.token_hash,
  link.password_hash,
  link.expires_at,
  link.revoked_at,
  link.download_count,
  link.max_downloads,
  link.last_downloaded_at,
  link.created_at
`;

const toIso = (value: Date | string | null): string | null =>
  value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;

const mapLinks = (rows: DbAttachmentLink[]): AttachmentLink[] =>
  rows.map((row) => ({
    id: row.id,
    mailboxId: row.mailbox_id,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    filename: row.filename,
    contentType: row.content_type,
    byteLength: Number(row.byte_length),
    passwordProtected: row.password_hash !== null,
    expiresAt: toIso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
    downloadCount: Number(row.download_count),
    maxDownloads: row.max_downloads == null ? null : Number(row.max_downloads),
    lastDownloadedAt: toIso(row.last_downloaded_at),
    createdAt: toIso(row.created_at)!,
  }));

const mapLink = (row: DbAttachmentLink): AttachmentLink => mapLinks([row])[0]!;

const publicOrigin = (value: unknown): string => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("Cloud app URL is not configured");
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  const localHostname = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHostname)) {
    throw new Error("Cloud app URL must use HTTPS outside local development");
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
};

export const publicAttachmentLinkPath = (token: string): string => `/share/mail/attachments/${encodeURIComponent(token)}`;

export const publicAttachmentLinkUrlForAppUrl = (appUrl: unknown, token: string): string =>
  `${publicOrigin(appUrl)}${publicAttachmentLinkPath(token)}`;

export const publicAttachmentLinkUrl = async (token: string): Promise<string> =>
  publicAttachmentLinkUrlForAppUrl(await coreSettings.get<string>("app.url"), token);

const sourceAttachment = async (
  params: {
    mailboxId: string;
    sourceKind: AttachmentLink["sourceKind"];
    sourceId: string;
    attachmentId: string;
  },
  db: typeof sql = sql,
): Promise<(AttachmentDownload & { sourceId: string }) | null> => {
  if (params.sourceKind === "message") {
    const [row] = await db<
      {
        blob_id: string;
        byte_length: string | number;
        chunk_size: number;
        chunk_count: number;
        content_hash: string;
        content_type: string;
        filename: string | null;
      }[]
    >`
      SELECT
        attachment.blob_id,
        blob.byte_length,
        blob.chunk_size,
        blob.chunk_count,
        blob.content_hash,
        attachment.content_type,
        attachment.filename
      FROM mail.attachments attachment
      JOIN mail.message_contents message ON message.id = attachment.message_id
      JOIN mail.message_part_blobs blob ON blob.id = attachment.blob_id AND blob.complete = true
      WHERE attachment.id = ${params.attachmentId}::uuid
        AND attachment.message_id = ${params.sourceId}::uuid
        AND message.mailbox_id = ${params.mailboxId}::uuid
      FOR UPDATE OF attachment
    `;
    return row
      ? {
          sourceId: params.sourceId,
          blobId: row.blob_id,
          total: Number(row.byte_length),
          chunkSize: row.chunk_size,
          chunkCount: row.chunk_count,
          contentHash: row.content_hash,
          contentType: row.content_type,
          filename: row.filename,
        }
      : null;
  }
  const [row] = await db<
    {
      blob_id: string;
      byte_length: string | number;
      chunk_size: number;
      chunk_count: number;
      content_hash: string;
      content_type: string;
      filename: string | null;
    }[]
  >`
    SELECT
      attachment.blob_id,
      blob.byte_length,
      blob.chunk_size,
      blob.chunk_count,
      blob.content_hash,
      attachment.content_type,
      attachment.filename
    FROM mail.draft_attachments attachment
    JOIN mail.drafts draft ON draft.id = attachment.draft_id
    JOIN mail.message_part_blobs blob ON blob.id = attachment.blob_id AND blob.complete = true
    WHERE attachment.id = ${params.attachmentId}::uuid
      AND attachment.draft_id = ${params.sourceId}::uuid
      AND draft.mailbox_id = ${params.mailboxId}::uuid
      AND attachment.removed_at IS NULL
    FOR UPDATE OF attachment
  `;
  return row
    ? {
        sourceId: params.sourceId,
        blobId: row.blob_id,
        total: Number(row.byte_length),
        chunkSize: row.chunk_size,
        chunkCount: row.chunk_count,
        contentHash: row.content_hash,
        contentType: row.content_type,
        filename: row.filename,
      }
    : null;
};

export const createPublicAttachmentLink = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  sourceKind: AttachmentLink["sourceKind"];
  sourceId: string;
  attachmentId: string;
  input: CreateAttachmentLinkRequest;
}): Promise<Result<CreatedAttachmentLink>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;
  const attachment = await sourceAttachment(params);
  if (!attachment) return fail(err.notFound("Attachment"));
  const now = new Date();
  const generated = await createAttachmentLink({
    fileSizeBytes: attachment.total,
    now,
    password: params.input.password,
    expiresAt: params.input.expiresAt ? new Date(params.input.expiresAt) : null,
    maxDownloads: params.input.maxDownloads,
  });
  if (!generated.ok) return fail(err.badInput(`Attachment link ${generated.code.replaceAll("_", " ")}`));
  let publicUrl: string;
  try {
    publicUrl = await publicAttachmentLinkUrl(generated.publicToken);
  } catch {
    return fail(err.internal("Public attachment links are not configured"));
  }
  const actor = actorRefFromRequest(params.context);
  if (actor.kind !== "user" && actor.kind !== "service_account") return fail(err.forbidden("Only interactive actors can create links"));
  const actorId = actor.kind === "user" ? actor.userId : actor.serviceAccountId;
  try {
    const row = await sql.begin(async (tx) => {
      const currentPermission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
      if (!currentPermission.ok) throw Object.assign(new Error("Mailbox access was revoked"), { code: "ACCESS_REVOKED" });
      const currentAttachment = await sourceAttachment(params, tx);
      if (
        !currentAttachment ||
        currentAttachment.blobId !== attachment.blobId ||
        currentAttachment.total !== attachment.total ||
        currentAttachment.contentHash !== attachment.contentHash
      ) {
        throw Object.assign(new Error("Attachment changed while creating link"), { code: "ATTACHMENT_CHANGED" });
      }
      const [created] = await tx<DbAttachmentLink[]>`
        INSERT INTO mail.attachment_links AS link (
          mailbox_id, blob_id, source_kind, source_id, filename, content_type, byte_length,
          token_hash, password_hash, expires_at, max_downloads, created_by_actor_kind, created_by_actor_id
        )
        VALUES (
          ${params.mailboxId}::uuid,
          ${currentAttachment.blobId}::uuid,
          ${params.sourceKind},
          ${params.sourceId}::uuid,
          ${currentAttachment.filename},
          ${currentAttachment.contentType},
          ${currentAttachment.total},
          ${generated.persistent.tokenHash},
          ${generated.persistent.passwordHash},
          ${generated.persistent.expiresAt},
          ${generated.persistent.maxDownloads},
          ${actor.kind},
          ${actorId}::uuid
        )
        RETURNING ${linkColumns}
      `;
      if (!created) throw new Error("Attachment link insert returned no row");
      await audit.record(
        {
          action: "mail.attachment_link.create",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "mail_attachment_link", id: created.id },
          requestId: params.context.requestId,
          metadata: {
            mailboxId: params.mailboxId,
            sourceKind: params.sourceKind,
            sourceId: params.sourceId,
            byteLength: currentAttachment.total,
            passwordProtected: created.password_hash !== null,
            expiresAt: toIso(created.expires_at),
          },
        },
        tx,
      );
      return created;
    });
    return ok({ link: await mapLink(row), url: publicUrl });
  } catch (error) {
    if ((error as { code?: string }).code === "ACCESS_REVOKED") return fail(err.forbidden("Mailbox access was revoked"));
    if ((error as { code?: string }).code === "ATTACHMENT_CHANGED") return fail(err.conflict("Attachment changed; retry link creation"));
    return fail(err.internal("Failed to create attachment link"));
  }
};

export const listPublicAttachmentLinks = async (
  context: MailRequestContext,
  mailboxId: string,
  input: { cursor?: string; limit?: number } = {},
): Promise<Result<AttachmentLinkPage>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "admin");
  if (!allowed.ok) return allowed;
  const cursor = decodeAttachmentLinkCursor(input.cursor);
  if (!cursor.ok) return cursor;
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), 100);
  const rows = await sql<DbAttachmentLink[]>`
    SELECT ${linkColumns}
    FROM mail.attachment_links link
    WHERE link.mailbox_id = ${mailboxId}::uuid
      AND (
        ${cursor.data?.createdAt ?? null}::timestamptz IS NULL
        OR (link.created_at, link.id) < (${cursor.data?.createdAt ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid)
      )
    ORDER BY link.created_at DESC, link.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const items = await mapLinks(hasMore ? rows.slice(0, limit) : rows);
  const last = items.at(-1);
  return ok({
    items,
    nextCursor: hasMore && last ? encodeAttachmentLinkCursor({ version: 1, createdAt: last.createdAt, id: last.id }) : null,
  });
};

export const revokePublicAttachmentLink = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  linkId: string;
}): Promise<Result<AttachmentLink>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;
  const row = await sql.begin(async (tx) => {
    const currentPermission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
    if (!currentPermission.ok) return null;
    const [updated] = await tx<DbAttachmentLink[]>`
      UPDATE mail.attachment_links link
      SET revoked_at = COALESCE(link.revoked_at, now())
      WHERE link.id = ${params.linkId}::uuid AND link.mailbox_id = ${params.mailboxId}::uuid
      RETURNING ${linkColumns}
    `;
    if (!updated) return null;
    await tx`DELETE FROM mail.attachment_link_grants WHERE link_id = ${updated.id}::uuid`;
    await audit.record(
      {
        action: "mail.attachment_link.revoke",
        outcome: "allowed",
        actor: auditActorFromRequest(params.context),
        target: { type: "mail_attachment_link", id: updated.id },
        requestId: params.context.requestId,
        metadata: { mailboxId: params.mailboxId },
      },
      tx,
    );
    return updated;
  });
  return row ? ok(await mapLink(row)) : fail(err.notFound("Attachment link"));
};

const publicLinkByToken = async (publicToken: string): Promise<DbAttachmentLink | null> => {
  if (!PUBLIC_TOKEN_PATTERN.test(publicToken)) return null;
  const [row] = await sql<DbAttachmentLink[]>`
    SELECT ${linkColumns}
    FROM mail.attachment_links link
    JOIN mail.mailboxes mailbox ON mailbox.id = link.mailbox_id AND mailbox.deleted_at IS NULL
    WHERE link.token_hash = ${hashAttachmentLinkToken(publicToken)}
      AND link.revoked_at IS NULL
      AND (link.expires_at IS NULL OR link.expires_at > now())
      AND (link.max_downloads IS NULL OR link.download_count < link.max_downloads)
  `;
  return row ?? null;
};

export const getPublicAttachmentLinkPresentation = async (
  publicToken: string,
): Promise<Result<{ filename: string | null; byteLength: number; passwordProtected: boolean }>> => {
  const row = await publicLinkByToken(publicToken);
  if (!row || !row.blob_id) return fail(err.notFound("Attachment link"));
  return ok({
    filename: row.password_hash ? null : row.filename,
    byteLength: row.password_hash ? 0 : Number(row.byte_length),
    passwordProtected: row.password_hash !== null,
  });
};

const grantHash = (token: string): string => createHash("sha256").update(`mail-attachment-grant:${token}`).digest("hex");

export const unlockPublicAttachmentLink = async (
  publicToken: string,
  password?: string | null,
): Promise<Result<{ grantToken: string; expiresAt: string }>> => {
  const row = await publicLinkByToken(publicToken);
  if (!row || !row.blob_id) return fail(err.notFound("Attachment link"));
  if (row.password_hash) {
    if (!isValidPassword(password)) return fail(err.notFound("Attachment link"));
    try {
      if (!(await Bun.password.verify(password, row.password_hash))) return fail(err.notFound("Attachment link"));
    } catch {
      return fail(err.notFound("Attachment link"));
    }
  }
  const grantToken = randomBytes(32).toString("base64url");
  const [grant] = await sql<{ expires_at: Date | string }[]>`
    INSERT INTO mail.attachment_link_grants (token_hash, link_id, expires_at)
    VALUES (
      ${grantHash(grantToken)},
      ${row.id}::uuid,
      LEAST(now() + interval '30 minutes', COALESCE(${row.expires_at}::timestamptz, 'infinity'::timestamptz))
    )
    RETURNING expires_at
  `;
  if (!grant) return fail(err.internal("Failed to authorize attachment download"));
  return ok({ grantToken, expiresAt: toIso(grant.expires_at)! });
};

export const inspectPublicAttachmentDownload = async (params: {
  publicToken: string;
  grantToken: string;
}): Promise<Result<AttachmentDownload & { linkId: string }>> => {
  if (!PUBLIC_TOKEN_PATTERN.test(params.publicToken) || !PUBLIC_TOKEN_PATTERN.test(params.grantToken)) {
    return fail(err.notFound("Attachment link"));
  }
  const [row] = await sql<
    {
      link_id: string;
      blob_id: string;
      content_type: string;
      filename: string | null;
      byte_length: string | number;
      chunk_size: number;
      chunk_count: number;
      content_hash: string;
    }[]
  >`
    SELECT
      link.id AS link_id,
      link.blob_id,
      link.content_type,
      link.filename,
      blob.byte_length,
      blob.chunk_size,
      blob.chunk_count,
      blob.content_hash
    FROM mail.attachment_links link
    JOIN mail.mailboxes mailbox ON mailbox.id = link.mailbox_id AND mailbox.deleted_at IS NULL
    JOIN mail.attachment_link_grants link_grant
      ON link_grant.link_id = link.id
      AND link_grant.token_hash = ${grantHash(params.grantToken)}
      AND link_grant.expires_at > now()
    JOIN mail.message_part_blobs blob ON blob.id = link.blob_id AND blob.complete = true
    WHERE link.token_hash = ${hashAttachmentLinkToken(params.publicToken)}
      AND link.revoked_at IS NULL
      AND (link.expires_at IS NULL OR link.expires_at > now())
      AND (link_grant.download_claimed_at IS NOT NULL OR link.max_downloads IS NULL OR link.download_count < link.max_downloads)
  `;
  if (!row) return fail(err.notFound("Attachment link"));
  return ok({
    linkId: row.link_id,
    blobId: row.blob_id,
    total: Number(row.byte_length),
    chunkSize: row.chunk_size,
    chunkCount: row.chunk_count,
    contentHash: row.content_hash,
    contentType: row.content_type,
    filename: row.filename,
  });
};

export const assertPublicAttachmentDownloadAccess = async (linkId: string, grantToken: string): Promise<void> => {
  if (!PUBLIC_TOKEN_PATTERN.test(grantToken)) throw new Error("Attachment link access was revoked");
  const [row] = await sql<{ available: boolean }[]>`
    SELECT true AS available
    FROM mail.attachment_links link
    JOIN mail.mailboxes mailbox ON mailbox.id = link.mailbox_id AND mailbox.deleted_at IS NULL
    JOIN mail.attachment_link_grants link_grant ON link_grant.link_id = link.id
    WHERE link.id = ${linkId}::uuid
      AND link_grant.token_hash = ${grantHash(grantToken)}
      AND link_grant.expires_at > now()
      AND link.revoked_at IS NULL
      AND (link.expires_at IS NULL OR link.expires_at > now())
  `;
  if (!row?.available) throw new Error("Attachment link access was revoked");
};

export const claimPublicAttachmentDownload = async (params: {
  publicToken: string;
  grantToken: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<Result<AttachmentDownload & { linkId: string }>> => {
  if (!PUBLIC_TOKEN_PATTERN.test(params.publicToken) || !PUBLIC_TOKEN_PATTERN.test(params.grantToken)) {
    return fail(err.notFound("Attachment link"));
  }
  const tokenHash = hashAttachmentLinkToken(params.publicToken);
  try {
    const claimed = await sql.begin(async (tx) => {
      const [row] = await tx<DbAttachmentLink[]>`
        SELECT ${linkColumns}
        FROM mail.attachment_links link
        JOIN mail.mailboxes mailbox ON mailbox.id = link.mailbox_id AND mailbox.deleted_at IS NULL
        WHERE link.token_hash = ${tokenHash}
          AND link.revoked_at IS NULL
          AND (link.expires_at IS NULL OR link.expires_at > now())
        FOR UPDATE OF link
      `;
      if (!row || !row.blob_id) return null;
      const [grant] = await tx<{ token_hash: string; download_claimed_at: Date | string | null }[]>`
        SELECT token_hash, download_claimed_at
        FROM mail.attachment_link_grants
        WHERE token_hash = ${grantHash(params.grantToken)}
          AND link_id = ${row.id}::uuid
          AND expires_at > now()
        FOR UPDATE
      `;
      if (!grant) return null;
      const firstRequest = grant.download_claimed_at === null;
      if (firstRequest && row.max_downloads != null && Number(row.download_count) >= Number(row.max_downloads)) return null;
      const [blob] = await tx<{ chunk_size: number; chunk_count: number; content_hash: string; byte_length: string | number }[]>`
        SELECT chunk_size, chunk_count, content_hash, byte_length
        FROM mail.message_part_blobs
        WHERE id = ${row.blob_id}::uuid AND complete = true
      `;
      if (!blob || Number(blob.byte_length) !== Number(row.byte_length)) return null;
      if (firstRequest) {
        await tx`
          UPDATE mail.attachment_links
          SET download_count = download_count + 1, last_downloaded_at = now()
          WHERE id = ${row.id}::uuid
        `;
        await tx`
          UPDATE mail.attachment_link_grants
          SET download_claimed_at = now()
          WHERE token_hash = ${grant.token_hash}
        `;
        await tx`
          INSERT INTO mail.activity_events (
            mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
          )
          VALUES (
            ${row.mailbox_id}::uuid,
            'system',
            NULL,
            'attachment_link.download',
            'confirmed',
            'attachment_link',
            ${row.id}::uuid,
            ${{ ip: params.ip ?? null, userAgent: params.userAgent?.slice(0, 500) ?? null }}::jsonb
          )
        `;
      }
      return { row, blob };
    });
    if (!claimed) return fail(err.notFound("Attachment link"));
    return ok({
      linkId: claimed.row.id,
      blobId: claimed.row.blob_id!,
      total: Number(claimed.blob.byte_length),
      chunkSize: claimed.blob.chunk_size,
      chunkCount: claimed.blob.chunk_count,
      contentHash: claimed.blob.content_hash,
      contentType: claimed.row.content_type,
      filename: claimed.row.filename,
    });
  } catch {
    return fail(err.notFound("Attachment link"));
  }
};

export const cleanupPublicAttachmentLinks = async (): Promise<{ grants: number; detachedBlobs: number }> => {
  const grants = await sql<{ token_hash: string }[]>`
    DELETE FROM mail.attachment_link_grants
    WHERE expires_at <= now()
    RETURNING token_hash
  `;
  const detached = await sql<{ id: string }[]>`
    UPDATE mail.attachment_links
    SET blob_id = NULL
    WHERE blob_id IS NOT NULL
      AND (
        revoked_at < now() - interval '30 days'
        OR expires_at < now() - interval '30 days'
      )
    RETURNING id
  `;
  return { grants: grants.length, detachedBlobs: detached.length };
};
