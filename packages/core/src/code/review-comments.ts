import { sql } from "@k2b/cloud";
import { CAPABILITY_MAX_RESULT_BYTES } from "@k2b/cloud/contracts";
import type { SQL } from "bun";
import type { z } from "zod";
import { type CodeContext, CodeDataError } from "./access";
import { requireCodePolicyAdmin } from "./policy";
import { CODE_REVIEW_COMMENT_LIMIT, type CodeReviewComment, codeReviewCommentContracts } from "./review-contracts";

type Row = {
  id: string;
  author_user_id: string | null;
  name: string | null;
  avatar_hash: string | null;
  created_at: Date;
  body: string;
  parent_id: string | null;
  path: string;
  line: number;
};
const present = (row: Row, anchors: boolean): CodeReviewComment => ({
  id: row.id,
  author: { id: row.author_user_id, name: row.name, avatarHash: row.avatar_hash },
  createdAt: row.created_at.toISOString(),
  body: row.body,
  parentId: row.parent_id,
  ...(anchors ? { path: row.path, line: row.line } : {}),
});
/** Same lock as the winning decision. No writer can slip a comment into a frozen review. */
async function lockOpenReview(input: { codeId: string; versionId: string }, tx: SQL) {
  await tx`SELECT id FROM code.codes WHERE id=${input.codeId} FOR UPDATE`;
  const [version] = await tx<{ source_files: Record<string, string>; open: boolean }[]>`
    SELECT v.source_files, (r.status='pending' AND r.expires_at>now() AND NOT EXISTS
      (SELECT 1 FROM code.version_decisions d WHERE d.version_id=v.id)) AS open
    FROM code.versions v JOIN code.version_submissions s ON s.version_id=v.id
    LEFT JOIN approvals.requests r ON r.id=s.approval_id WHERE v.id=${input.versionId}::uuid AND v.code_id=${input.codeId}`;
  if (!version) throw new CodeDataError("NOT_FOUND", "Code review not found.");
  if (!version.open) throw new CodeDataError("CONFLICT", "The review is no longer pending. Comments are frozen.");
  return version.source_files;
}

/** Admin-only draft comments; replies share the root's immutable new-version anchor. */
export async function createCodeReviewComment(raw: z.input<typeof codeReviewCommentContracts.create.input>, context: CodeContext) {
  const author = requireCodePolicyAdmin(context, true);
  const input = codeReviewCommentContracts.create.input.parse(raw);
  return sql.begin(async (tx) => {
    const files = await lockOpenReview(input, tx);
    if (!Object.hasOwn(files, input.path) || input.line > files[input.path]!.split("\n").length)
      throw new CodeDataError("BAD_INPUT", "Comment anchor is not a line in this version.");
    let parentId: string | null = null;
    if (input.parentId) {
      const [parent] = await tx<{ id: string; parent_id: string | null; path: string; line: number }[]>`
        SELECT id,parent_id,path,line FROM code.version_comments WHERE id=${input.parentId}::uuid AND version_id=${input.versionId}::uuid`;
      if (!parent || parent.path !== input.path || parent.line !== input.line)
        throw new CodeDataError("BAD_INPUT", "Reply must belong to the same version and line.");
      parentId = parent.parent_id ?? parent.id;
    }
    const [count] = await tx<
      { total: number }[]
    >`SELECT count(*)::int AS total FROM code.version_comments WHERE version_id=${input.versionId}::uuid`;
    if (count!.total >= CODE_REVIEW_COMMENT_LIMIT) throw new CodeDataError("BAD_INPUT", "The review comment budget is full.");
    const [row] = await tx<{ id: string }[]>`INSERT INTO code.version_comments(version_id,author_user_id,path,line,body,parent_id)
      VALUES(${input.versionId}::uuid,${author.id}::uuid,${input.path},${input.line},${input.body},${parentId}::uuid) RETURNING id`;
    const [created] = await tx<Row[]>`SELECT c.*,COALESCE(NULLIF(u.display_name,''),u.uid) AS name,u.avatar_hash
      FROM code.version_comments c LEFT JOIN auth.users u ON u.id=c.author_user_id WHERE c.id=${row!.id}::uuid`;
    return present(created!, true);
  });
}

export async function deleteCodeReviewComment(raw: z.input<typeof codeReviewCommentContracts.delete.input>, context: CodeContext) {
  const author = requireCodePolicyAdmin(context, true);
  const input = codeReviewCommentContracts.delete.input.parse(raw);
  await sql.begin(async (tx) => {
    await lockOpenReview(input, tx);
    const [own] =
      await tx`SELECT id FROM code.version_comments WHERE id=${input.id}::uuid AND version_id=${input.versionId}::uuid AND author_user_id=${author.id}::uuid`;
    if (!own) throw new CodeDataError("NOT_FOUND", "Comment not found.");
    // Keep other authors' replies, on their existing anchor, when a root is deleted.
    await tx`UPDATE code.version_comments SET parent_id=NULL WHERE parent_id=${input.id}::uuid AND version_id=${input.versionId}::uuid`;
    await tx`DELETE FROM code.version_comments WHERE id=${input.id}::uuid AND version_id=${input.versionId}::uuid AND author_user_id=${author.id}::uuid`;
  });
  return { deleted: true as const };
}

/** Trusted projection; caller authorizes the Code and publication first. No path or line is serialized for a surface without source. */
export async function readCodeReviewComments(
  input: z.output<typeof codeReviewCommentContracts.list.input>,
  anchors: boolean,
  db: SQL = sql,
) {
  const [count] = await db<
    { total: number }[]
  >`SELECT count(*)::int AS total FROM code.version_comments WHERE version_id=${input.versionId}::uuid`;
  const rows = await db<Row[]>`SELECT c.*,COALESCE(NULLIF(u.display_name,''),u.uid) AS name,u.avatar_hash
    FROM code.version_comments c LEFT JOIN auth.users u ON u.id=c.author_user_id
    WHERE c.version_id=${input.versionId}::uuid AND (${input.before ?? null}::uuid IS NULL OR (c.created_at,c.id)<
      (SELECT created_at,id FROM code.version_comments WHERE id=${input.before ?? null}::uuid AND version_id=${input.versionId}::uuid))
    ORDER BY c.created_at DESC,c.id DESC LIMIT ${input.limit + 1}`;
  const items: CodeReviewComment[] = [];
  let bytes = 0;
  for (const row of rows.slice(0, input.limit)) {
    const item = present(row, anchors);
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > CAPABILITY_MAX_RESULT_BYTES / 2) break;
    bytes += size;
    items.push(item);
  }
  return { items, nextBefore: rows.length > items.length ? items.at(-1)!.id : null, total: count!.total };
}

export async function listCodeReviewComments(raw: z.input<typeof codeReviewCommentContracts.list.input>, context: CodeContext) {
  requireCodePolicyAdmin(context);
  const input = codeReviewCommentContracts.list.input.parse(raw);
  const [version] =
    await sql`SELECT version_id FROM code.version_submissions WHERE code_id=${input.codeId} AND version_id=${input.versionId}::uuid`;
  if (!version) throw new CodeDataError("NOT_FOUND", "Code review not found.");
  return readCodeReviewComments(input, true);
}
