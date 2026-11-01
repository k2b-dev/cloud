import { createHash, randomBytes } from "node:crypto";
import type { SQL, TransactionSQL } from "bun";
import { isPurposeName, validatePurposeName } from "../../_internal/purpose-name";
import { ensureSchema } from "../postgres";

export type CreateLinkInput = { purpose: string; subject: string; ttl: number };
export type CreatedLink = { token: string; expiresAt: Date };
export type RedeemedLink = { subject: string; createdAt: Date };
export type PeekedLink = RedeemedLink & { expiresAt: Date };
export type LinkOptions = { tx?: TransactionSQL };
type LinkResult<T> = { ok: true; data: T } | { ok: false; error: { code: "LINK_INVALID" } };
export type RedeemLinkResult = LinkResult<RedeemedLink>;
export type PeekLinkResult = LinkResult<PeekedLink>;

const TOKEN = /^cl_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
// Match the existing outgoing-mail retention batch budget.
export const LINK_CLEANUP_BATCH = 1000;
const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const linkCandidate = (token: string, purpose: string) => {
  const value = typeof token === "string" ? token : "";
  const digest = hashToken(value);
  const validPurpose = isPurposeName(purpose);
  return { digest, purpose: validPurpose ? purpose : "", valid: TOKEN.test(value) && validPurpose };
};

export const validateCreateLink = (input: CreateLinkInput): void => {
  validatePurposeName(input.purpose);
  if (typeof input.subject !== "string" || Buffer.byteLength(input.subject, "utf8") > 1024) {
    throw new TypeError("Link subject must be a string of at most 1024 UTF-8 bytes");
  }
  if (!Number.isFinite(input.ttl) || input.ttl < 60 || input.ttl > 30 * 24 * 60 * 60) {
    throw new RangeError("Link ttl must be seconds from 60 to 2592000 (30 days)");
  }
};

/** One reserved platform table in the same database as the application's domain transactions. */
export const setupLinks = async (db: SQL): Promise<void> => {
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('cloud.links'))`;
    await ensureSchema(tx, "platform");
    const [existing] = await tx<{ table_exists: boolean; index_exists: boolean }[]>`
      SELECT to_regclass('platform._cloud_links') IS NOT NULL AS table_exists,
        to_regclass('platform._cloud_links_retention') IS NOT NULL AS index_exists`;
    if (!existing?.table_exists)
      await tx`CREATE TABLE IF NOT EXISTS platform._cloud_links (
      package text NOT NULL, token_hash text NOT NULL, purpose text NOT NULL, subject bytea NOT NULL,
      created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz,
      PRIMARY KEY (package, token_hash)
    )`.simple();
    // Even IF NOT EXISTS takes a ShareLock; skip index DDL on ordinary app restarts.
    if (!existing?.index_exists)
      await tx`CREATE INDEX IF NOT EXISTS _cloud_links_retention ON platform._cloud_links (LEAST(expires_at, used_at))`.simple();
  });
};

export const createLinksStore = (db: SQL, packageName: string) => ({
  create: async (input: CreateLinkInput, options: LinkOptions = {}): Promise<CreatedLink> => {
    validateCreateLink(input);
    const token = `cl_${randomBytes(32).toString("base64url")}`;
    const [row] = await (options.tx ?? db)<{ expires_at: Date }[]>`
      INSERT INTO platform._cloud_links (package, token_hash, purpose, subject, created_at, expires_at)
      VALUES (${packageName}, ${hashToken(token)}, ${input.purpose}, ${Buffer.from(input.subject, "utf8")},
        statement_timestamp(), statement_timestamp() + ${input.ttl} * interval '1 second')
      RETURNING expires_at`;
    if (!row) throw new Error("One-time link insert returned no expiry");
    return { token, expiresAt: row.expires_at };
  },
  peek: async (token: string, input: { purpose: string }, options: LinkOptions = {}): Promise<PeekLinkResult> => {
    const candidate = linkCandidate(token, input.purpose);
    const [row] = await (options.tx ?? db)<{ subject: Uint8Array; created_at: Date; expires_at: Date }[]>`
      SELECT subject, created_at, expires_at FROM platform._cloud_links
      WHERE package = ${packageName} AND token_hash = ${candidate.digest} AND purpose = ${candidate.purpose}
        AND ${candidate.valid}::boolean AND used_at IS NULL AND expires_at > clock_timestamp()`;
    return row
      ? { ok: true, data: { subject: Buffer.from(row.subject).toString("utf8"), createdAt: row.created_at, expiresAt: row.expires_at } }
      : { ok: false, error: { code: "LINK_INVALID" } };
  },
  redeem: async (token: string, input: { purpose: string }, options: LinkOptions = {}): Promise<RedeemLinkResult> => {
    // Every candidate is hashed and reaches one indexed UPDATE, including malformed credentials.
    const candidate = linkCandidate(token, input.purpose);
    const [row] = await (options.tx ?? db)<{ subject: Uint8Array; created_at: Date }[]>`
      UPDATE platform._cloud_links SET used_at = clock_timestamp()
      WHERE package = ${packageName} AND token_hash = ${candidate.digest} AND purpose = ${candidate.purpose}
        AND ${candidate.valid}::boolean AND used_at IS NULL AND expires_at > clock_timestamp()
      RETURNING subject, created_at`;
    return row
      ? { ok: true, data: { subject: Buffer.from(row.subject).toString("utf8"), createdAt: row.created_at } }
      : { ok: false, error: { code: "LINK_INVALID" } };
  },
});

/** Platform maintenance spans packages; the application facade never exposes this operation. */
export const cleanupLinksBatch = async (db: SQL): Promise<number> =>
  db.begin(async (tx) => {
    await tx`SET LOCAL statement_timeout = '10s'`;
    const rows = await tx<{ token_hash: string }[]>`
      WITH expired AS (
        SELECT package, token_hash FROM platform._cloud_links
        WHERE LEAST(expires_at, used_at) < statement_timestamp() - interval '24 hours'
        ORDER BY LEAST(expires_at, used_at) LIMIT ${LINK_CLEANUP_BATCH} FOR UPDATE SKIP LOCKED
      ) DELETE FROM platform._cloud_links link USING expired
        WHERE link.package = expired.package AND link.token_hash = expired.token_hash RETURNING link.token_hash`;
    return rows.length;
  });
