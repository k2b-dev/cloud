import { sql } from "@k2b/cloud";
import { CODE_CHECK_LIMITS } from "@k2b/cloud/code";
import type { z } from "zod";
import { CodeDataError } from "./access";
import type { CodeChatDraftSummarySchema } from "./authoring-contracts";
import type { CodeSourceFiles } from "./contracts";

// The same week window as the other Code retention windows; abandoned edits must not accumulate forever.
export const CODE_CHAT_DRAFT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export type CodeChatDraftParts = {
  entry: string;
  files: CodeSourceFiles;
  tests: CodeSourceFiles;
  baseVersionId: string | null;
};
export type CodeChatDraft = CodeChatDraftParts & { codeId: string; expiresAt: string };
type Row = {
  entry: string;
  files: CodeSourceFiles;
  tests: CodeSourceFiles;
  base_version_id: string | null;
  expires_at: Date;
};
export function requireCodeChatDraft(draft: CodeChatDraftParts | null): CodeChatDraftParts {
  if (!draft) throw new CodeDataError("NOT_FOUND", "Code draft not found or expired. Call code_pull (or code_init) first.");
  return draft;
}
function validate(draft: CodeChatDraftParts) {
  const sourceBytes = Object.values(draft.files).reduce((total, content) => total + Buffer.byteLength(content), 0);
  const testBytes = Object.values(draft.tests).reduce((total, content) => total + Buffer.byteLength(content), 0);
  if (Object.keys(draft.files).length > CODE_CHECK_LIMITS.files)
    throw new CodeDataError("BAD_INPUT", `Code draft exceeds the ${CODE_CHECK_LIMITS.files} source file limit.`);
  if (sourceBytes > CODE_CHECK_LIMITS.sourceBytes)
    throw new CodeDataError("BAD_INPUT", `Code draft exceeds the ${CODE_CHECK_LIMITS.sourceBytes} source byte limit.`);
  if (sourceBytes + testBytes > CODE_CHECK_LIMITS.requestBytes)
    throw new CodeDataError("BAD_INPUT", `Code draft source and tests exceed the ${CODE_CHECK_LIMITS.requestBytes} byte limit.`);
  // Paths and structure count too, so many empty fixtures cannot grow the stored draft past the request budget.
  if (Buffer.byteLength(JSON.stringify(draft)) > CODE_CHECK_LIMITS.requestBytes)
    throw new CodeDataError("BAD_INPUT", `Code draft exceeds the ${CODE_CHECK_LIMITS.requestBytes} byte limit.`);
}
/** Internal store: chat-tools must authorize this Code and supply its current conversation before every call.
 * The advisory lock also serializes first creation and replacement of expired rows; row locks protect existing edits.
 * Bounds are checked against the complete post-edit state before anything is committed.
 */
export async function updateCodeChatDraft(
  codeId: string,
  conversationId: string,
  edit: (current: CodeChatDraftParts | null) => CodeChatDraftParts,
): Promise<CodeChatDraft> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([codeId, conversationId])},0))`;
    const now = new Date();
    const [row] = await tx<Row[]>`SELECT entry,files,tests,base_version_id,expires_at FROM code.chat_drafts
      WHERE code_id=${codeId} AND conversation_id=${conversationId}::uuid FOR UPDATE`;
    const current =
      row && row.expires_at > now ? { entry: row.entry, files: row.files, tests: row.tests, baseVersionId: row.base_version_id } : null;
    // A read-only command neither changes state nor extends its lifetime.
    const next = edit(current);
    validate(next);
    const sameFiles = (left: CodeSourceFiles, right: CodeSourceFiles) =>
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every((path) => Object.hasOwn(right, path) && left[path] === right[path]);
    if (
      row &&
      current &&
      current.entry === next.entry &&
      current.baseVersionId === next.baseVersionId &&
      sameFiles(current.files, next.files) &&
      sameFiles(current.tests, next.tests)
    )
      return { ...next, codeId, expiresAt: row.expires_at.toISOString() };
    const expiresAt = new Date(now.getTime() + CODE_CHAT_DRAFT_LIFETIME_MS);
    await tx`INSERT INTO code.chat_drafts(code_id,conversation_id,entry,files,tests,base_version_id,updated_at,expires_at)
      VALUES(${codeId},${conversationId}::uuid,${next.entry},${JSON.stringify(next.files)}::text::jsonb,${JSON.stringify(next.tests)}::text::jsonb,
        ${next.baseVersionId}::uuid,${now},${expiresAt})
      ON CONFLICT(code_id,conversation_id) DO UPDATE SET
        entry=EXCLUDED.entry,files=EXCLUDED.files,tests=EXCLUDED.tests,base_version_id=EXCLUDED.base_version_id,
        updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at`;
    return { ...next, codeId, expiresAt: expiresAt.toISOString() };
  });
}
/**
 * After a submit, moves the draft to the new version only while it still holds exactly what was submitted. A draft
 * replaced meanwhile, such as by a pull, or one that expired keeps its state; nothing fails because of it.
 */
export async function advanceCodeChatDraftBase(
  codeId: string,
  conversationId: string,
  submitted: CodeChatDraftParts,
  versionId: string,
): Promise<void> {
  const now = new Date();
  await sql`UPDATE code.chat_drafts SET base_version_id=${versionId}::uuid,updated_at=${now},
      expires_at=${new Date(now.getTime() + CODE_CHAT_DRAFT_LIFETIME_MS)}
    WHERE code_id=${codeId} AND conversation_id=${conversationId}::uuid AND expires_at>${now}
      AND entry=${submitted.entry} AND files=${JSON.stringify(submitted.files)}::text::jsonb
      AND tests=${JSON.stringify(submitted.tests)}::text::jsonb
      AND base_version_id IS NOT DISTINCT FROM ${submitted.baseVersionId}::uuid`;
}
export function codeChatDraftSummary(draft: CodeChatDraft): z.infer<typeof CodeChatDraftSummarySchema> {
  const list = (files: CodeSourceFiles) =>
    Object.keys(files)
      .sort()
      .map((path) => ({ path, bytes: Buffer.byteLength(files[path]!) }));
  return {
    version: 1,
    draft: {
      codeId: draft.codeId,
      entry: draft.entry,
      baseVersionId: draft.baseVersionId,
      files: list(draft.files),
      tests: list(draft.tests),
      expiresAt: draft.expiresAt,
    },
  };
}
/**
 * One bounded batch in the existing sweep; replicas skip rows another sweep or edit owns. Drafts of a deleted chat go
 * too. AI migrates after Code, so the draft has no foreign key to its chat; the sweep checks once the chats exist.
 */
export async function expireCodeChatDrafts({ now, limit }: { now: Date; limit: number }): Promise<void> {
  await sql`DELETE FROM code.chat_drafts WHERE ctid IN (
    SELECT ctid FROM code.chat_drafts WHERE expires_at<=${now} ORDER BY expires_at
    LIMIT ${limit} FOR UPDATE SKIP LOCKED
  )`;
  const [chats] = await sql<{ table: string | null }[]>`SELECT to_regclass('ai.conversations')::text AS table`;
  if (!chats?.table) return;
  await sql`DELETE FROM code.chat_drafts WHERE ctid IN (
    SELECT draft.ctid FROM code.chat_drafts draft
    WHERE NOT EXISTS (SELECT 1 FROM ai.conversations chat WHERE chat.id=draft.conversation_id)
    LIMIT ${limit} FOR UPDATE SKIP LOCKED
  )`;
}
