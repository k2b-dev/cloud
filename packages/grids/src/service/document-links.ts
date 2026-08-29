import { createHash, randomBytes } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { coreSettings } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { CreateDocumentLinkInput, Document, DocumentLink, DocumentLinkTtl } from "../contracts";
import { logAudit, type SqlClient } from "./audit";
import { type DocumentDbRow, hydrateDocuments, mapDocumentLink } from "./document-mappers";
import { documentServiceText } from "./document-messages";
import { insertWithShortIdForDb } from "./short-id";

const DOCUMENT_LINK_TOKEN_PREFIX = "gdl_";
const DOCUMENT_LINK_TOKEN_BYTES = 32;
const DOCUMENT_LINK_TTL_MS: Record<DocumentLinkTtl, number> = {
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

const generateDocumentLinkToken = (): string =>
  `${DOCUMENT_LINK_TOKEN_PREFIX}${randomBytes(DOCUMENT_LINK_TOKEN_BYTES).toString("base64url")}`;

const hashDocumentLinkToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const normalizeDocumentLinkToken = (token: string): string | null => {
  const normalized = token.trim();
  if (!normalized.startsWith(DOCUMENT_LINK_TOKEN_PREFIX)) return null;
  if (normalized.length < DOCUMENT_LINK_TOKEN_PREFIX.length + 32 || normalized.length > 160) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(normalized.slice(DOCUMENT_LINK_TOKEN_PREFIX.length))) return null;
  return normalized;
};

const normalizeDocumentLinkComment = (comment: string | null | undefined): string | null => {
  const normalized = comment?.trim() ?? "";
  return normalized ? normalized.slice(0, 500) : null;
};

const documentLinkExpiresAt = (expiresIn: DocumentLinkTtl): Date => new Date(Date.now() + DOCUMENT_LINK_TTL_MS[expiresIn]);

const publicUrlValue = (value: unknown): string => {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${/^localhost(?::|\/|$)/i.test(url) ? "http" : "https"}://${url}`;
};

export const publicDocumentLinkPath = (token: string): string => `/share/grids/documents/${encodeURIComponent(token)}`;

const publicDocumentLinkOrigin = (appUrl: unknown): string => publicUrlValue(appUrl).replace(/\/+$/, "") || "http://localhost:3000";

export const publicDocumentLinkBaseUrlForAppUrl = (appUrl: unknown): string =>
  `${publicDocumentLinkOrigin(appUrl)}${publicDocumentLinkPath("")}`;

export const publicDocumentLinkUrlForAppUrl = (appUrl: unknown, token: string): string =>
  `${publicDocumentLinkBaseUrlForAppUrl(appUrl)}${encodeURIComponent(token)}`;

export const publicDocumentLinkBaseUrl = async (): Promise<string> =>
  publicDocumentLinkBaseUrlForAppUrl(await coreSettings.get<string>("app.url"));

export const publicDocumentLinkUrl = async (token: string): Promise<string> =>
  `${await publicDocumentLinkBaseUrl()}${encodeURIComponent(token)}`;

export const listDocumentLinksForDocument = async (documentId: string): Promise<DocumentLink[]> => {
  const rows = await sql<DocumentDbRow[]>`
    SELECT *
    FROM grids.document_links
    WHERE document_id = ${documentId}::uuid
    ORDER BY created_at DESC, id DESC
  `;
  return rows.map(mapDocumentLink);
};

export const getDocumentLink = async (linkId: string): Promise<DocumentLink | null> => {
  const [row] = await sql<DocumentDbRow[]>`
    SELECT *
    FROM grids.document_links
    WHERE id = ${linkId}::uuid
  `;
  return row ? mapDocumentLink(row) : null;
};

export const getDocumentLinkByShortId = async (shortId: string): Promise<DocumentLink | null> => {
  const [row] = await sql<DocumentDbRow[]>`SELECT * FROM grids.document_links WHERE short_id = ${shortId}`;
  return row ? mapDocumentLink(row) : null;
};

export const createDocumentLink = async (params: {
  document: Document;
  input: CreateDocumentLinkInput;
  actorId: string | null;
  ip?: string | null;
  userAgent?: string | null;
  client?: SqlClient;
  locale?: string;
}): Promise<Result<{ link: DocumentLink; token: string }>> => {
  const t = documentServiceText(params.locale);
  const token = generateDocumentLinkToken();
  const expiresAt = documentLinkExpiresAt(params.input.expiresIn);
  const comment = normalizeDocumentLinkComment(params.input.comment);
  const create = async (tx: SqlClient): Promise<Result<{ link: DocumentLink; token: string }>> => {
    const row = await insertWithShortIdForDb(tx, "idx_grids_document_links_short_id", async (attempt, shortId) => {
      const [created] = await attempt<DocumentDbRow[]>`
        INSERT INTO grids.document_links (
          short_id, document_id, base_id, table_id, record_id, token_hash, comment, created_by, expires_at
        )
        VALUES (
          ${shortId},
          ${params.document.id}::uuid,
          ${params.document.baseId}::uuid,
          ${params.document.tableId}::uuid,
          ${params.document.recordId}::uuid,
          ${hashDocumentLinkToken(token)},
          ${comment},
          ${params.actorId}::uuid,
          ${expiresAt}
        )
        RETURNING *
      `;
      if (!created) throw new Error("insert returned no row");
      return created;
    });
    if (!row) return fail(err.internal(t.linkCreateFailed));
    const link = mapDocumentLink(row);
    await logAudit(
      {
        baseId: params.document.baseId,
        tableId: params.document.tableId,
        recordId: params.document.recordId,
        userId: params.actorId,
        action: "document_link.created",
        ip: params.ip,
        userAgent: params.userAgent,
        diff: {
          documentId: { old: null, new: params.document.shortId },
          documentLinkId: { old: null, new: link.id },
          expiresAt: { old: null, new: link.expiresAt },
          comment: { old: null, new: link.comment },
        },
      },
      tx,
    );
    return ok({ link, token });
  };
  return params.client ? create(params.client) : sql.begin(create);
};

export const revokeDocumentLink = async (params: {
  linkId: string;
  actorId: string | null;
  ip?: string | null;
  userAgent?: string | null;
  locale?: string;
}): Promise<Result<DocumentLink>> => {
  const t = documentServiceText(params.locale);
  return sql.begin(async (tx) => {
    const [row] = await tx<DocumentDbRow[]>`
      UPDATE grids.document_links
      SET revoked_at = now(), revoked_by = ${params.actorId}::uuid
      WHERE id = ${params.linkId}::uuid AND revoked_at IS NULL
      RETURNING *
    `;
    if (!row) {
      const [existing] = await tx<DocumentDbRow[]>`
        SELECT * FROM grids.document_links WHERE id = ${params.linkId}::uuid
      `;
      return existing ? ok(mapDocumentLink(existing)) : fail(err.notFound(t.documentLinkNotFound));
    }
    const link = mapDocumentLink(row);
    await logAudit(
      {
        baseId: link.baseId,
        tableId: link.tableId,
        recordId: link.recordId,
        userId: params.actorId,
        action: "document_link.revoked",
        ip: params.ip,
        userAgent: params.userAgent,
        diff: {
          documentId: { old: link.documentId, new: link.documentId },
          documentLinkId: { old: link.id, new: link.id },
          revokedAt: { old: null, new: link.revokedAt },
        },
      },
      tx,
    );
    return ok(link);
  });
};

export const resolveDocumentLinkDownload = async (
  token: string,
  locale?: string,
): Promise<Result<{ link: DocumentLink; document: Document }>> => {
  const t = documentServiceText(locale);
  const normalizedToken = normalizeDocumentLinkToken(token);
  if (!normalizedToken) return fail(err.notFound(t.documentLinkNotFound));

  const [row] = await sql<DocumentDbRow[]>`
    SELECT *
    FROM grids.document_links
    WHERE token_hash = ${hashDocumentLinkToken(normalizedToken)}
      AND revoked_at IS NULL
      AND expires_at > now()
  `;
  if (!row) return fail(err.notFound(t.documentLinkNotFound));
  const link = mapDocumentLink(row);
  const [documentRow] = await sql<DocumentDbRow[]>`
    SELECT * FROM grids.documents WHERE id = ${link.documentId}::uuid
  `;
  if (!documentRow) return fail(err.notFound(t.documentNotFound));
  const [document] = await hydrateDocuments([documentRow]);
  return document ? ok({ link, document }) : fail(err.internal(t.artifactsMissing));
};

export const recordDocumentLinkAccess = async (
  linkId: string,
  audit: { ip?: string | null; userAgent?: string | null } = {},
  locale?: string,
): Promise<Result<DocumentLink>> => {
  const t = documentServiceText(locale);
  return sql.begin(async (tx) => {
    const [row] = await tx<DocumentDbRow[]>`
      UPDATE grids.document_links
      SET access_count = access_count + 1, last_accessed_at = now()
      WHERE id = ${linkId}::uuid
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING *
    `;
    if (!row) return fail(err.notFound(t.documentLinkNotFound));
    const link = mapDocumentLink(row);

    await logAudit(
      {
        baseId: link.baseId,
        tableId: link.tableId,
        recordId: link.recordId,
        userId: null,
        action: "document_link.accessed",
        ip: audit.ip,
        userAgent: audit.userAgent,
        diff: {
          documentId: { old: link.documentId, new: link.documentId },
          documentLinkId: { old: link.id, new: link.id },
          accessCount: { old: link.accessCount - 1, new: link.accessCount },
        },
      },
      tx,
    );
    return ok(link);
  });
};
