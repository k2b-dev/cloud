import { sql } from "@k2b/cloud";
import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import { listPending, presentPendingApproval } from "@k2b/cloud/services/approvals";
import { diffArrays } from "diff";
import { type CodeContext, CodeDataError } from "./access";
import type { Code, CodeOwner, CodeRun, CodeSourceFiles } from "./contracts";
import { listCodeCleanupJobs } from "./lifecycle";
import type { CodeCleanupJob } from "./lifecycle-contracts";
import { readCodePolicyGroups, readCodePolicySnapshot, requireCodePolicyAdmin } from "./policy";
import { CODE_POLICY_ROWS, type CodePolicy, type CodePolicyRow, CodePolicyRowSchema, type CodePolicyValue } from "./policy-contracts";
import { effective } from "./policy-effective";
import { readCodeRunnerMetrics } from "./scheduling";
import type { CodeRunnerMetrics } from "./scheduling-contracts";
import { listCodeRuns } from "./store";
import {
  type CodeCheckedVersionManifest,
  CodeCheckedVersionManifestSchema,
  type CodeVersionBinding,
  type CodeVersionDecision,
  type CodeVersionDiffFile,
} from "./version-contracts";
import { diffCodeVersion, listCodeVersions } from "./versions";

/**
 * Cloud-admin read model for Administration › Code. Every reader requires the Code policy admin gate first;
 * mutations stay with the C8/C7 services (`decideCodeVersion`, `previewCodePolicy`, `updateCodePolicy`).
 */

/** Line totals for a changed version; `lines` counts the whole first version. Null totals mean the summary budget ran out. */
export type CodeAdminDiffStat = { first: boolean; added: number | null; removed: number | null; lines: number; files: number };
export type CodeAdminApproval = {
  approvalId: string;
  codeId: string;
  versionId: string;
  number: number;
  title: string;
  author: { id: string | null; name: string | null };
  submittedAt: string;
  /** Classifications of this version that currently need a Cloud admin for its author or owner. */
  rows: CodePolicyRow[];
  stat: CodeAdminDiffStat;
};
export type CodeAdminDecided = {
  codeId: string;
  versionId: string;
  number: number;
  title: string;
  approved: boolean;
  soleAdmin: boolean;
  decidedBy: string | null;
  decidedAt: string;
};
export type CodeAdminPermissionChange = {
  operation: string;
  target: { type: string; id: string | null } | null;
  file: string;
  line: number;
  change: "added" | "same" | "removed";
};
export type CodeAdminWhyRow = { row: CodePolicyRow; source: "default" | "group" | "veto"; groups: string[] };
export type CodeAdminApprovalDetail = {
  approvalId: string | null;
  status: "submitted" | "pending" | "approved" | "rejected" | "expired" | "cancelled";
  code: Pick<Code, "id" | "title" | "owner" | "state">;
  ownerName: string | null;
  version: { id: string; number: number; submittedAt: string; author: { id: string | null; name: string | null } };
  binding: CodeVersionBinding;
  comparison: { versionId: string; number: number; decidedAt: string | null; decidedBy: string | null } | null;
  /** Full rows for CodeDiff; null when the diff could not be read. */
  files: CodeVersionDiffFile[] | null;
  /** The baseline moved after submission; deciding would fail with code_comparison_stale. */
  staleComparison: boolean;
  permissions: CodeAdminPermissionChange[];
  why: CodeAdminWhyRow[];
  ai: boolean;
  newer: { versionId: string; number: number; author: string | null; submittedAt: string } | null;
  /** Only the advisory C5 eligibility; the decision rechecks it under locks. */
  canApprove: boolean;
  own: boolean;
  soleAdminNotice: string | null;
  decision: (CodeVersionDecision & { decidedByName: string | null }) | null;
  /** Localized catalog titles for operations and target types; ids stay the fallback. */
  titles: { operations: Record<string, string>; types: Record<string, string> };
};
export type CodeAdminCodeStatus = "active" | "paused" | "draft" | "deleting" | "waiting";
export type CodeAdminCode = {
  id: string;
  title: string;
  owner: CodeOwner;
  ownerName: string | null;
  state: Code["state"];
  status: CodeAdminCodeStatus;
  pauseReason: string | null;
  lastRun: { at: string; state: CodeRun["state"] } | null;
};
export type CodeAdminCodeFilter = { status?: CodeAdminCodeStatus; app?: string; q?: string };
export type CodeAdminCodeDetail = {
  code: CodeAdminCode & { activeVersionNumber: number | null; createdAt: string };
  versions: Awaited<ReturnType<typeof listCodeVersions>>["items"];
  runs: CodeRun[];
  cleanup: CodeCleanupJob[];
  pendingVersionId: string | null;
};
export type CodeAdminSummary = { approvals: number; codes: number; groups: number; cleanup: number };
export type CodeAdminPolicy = {
  policy: CodePolicy;
  updatedByName: string | null;
  /** Code with an active or paused version that uses a classification. */
  usage: Partial<Record<CodePolicyRow, number>>;
  groups: { id: string; name: string; rules: number; members: number; parents: string[] }[];
};
export type CodeAdminEffective = {
  person: { id: string; name: string };
  groups: { id: string; name: string; parents: string[] }[];
  rows: { row: CodePolicyRow; value: CodePolicyValue; source: "default" | "group" | "veto"; groups: string[] }[];
};

const PAGE = 20;
/** Opaque approval page cursor: request time with microseconds and request UUID. */
const APPROVAL_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{36}$/;
/** Shared budget for list summaries; exhaustion shows file counts instead of line totals. */
const SUMMARY_BUDGET_MS = 150;

const iso = (value: Date | string) => new Date(value).toISOString();
const lines = (text: string) => (text === "" ? [] : text.split("\n"));

/** Line totals for list rows under one shared time budget, never blocking the page on a pathological diff. */
export function codeAdminDiffStat(before: CodeSourceFiles | null, after: CodeSourceFiles, deadline: number): CodeAdminDiffStat {
  const paths = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])];
  const changed = paths.filter((path) => before?.[path] !== after[path]);
  const total = Object.values(after).reduce((sum, text) => sum + lines(text).length, 0);
  if (!before) return { first: true, added: total, removed: 0, lines: total, files: changed.length };
  let added = 0;
  let removed = 0;
  for (const path of changed) {
    const remaining = deadline - performance.now();
    const parts = remaining > 0 ? diffArrays(lines(before[path] ?? ""), lines(after[path] ?? ""), { timeout: remaining }) : undefined;
    if (!parts) return { first: false, added: null, removed: null, lines: total, files: changed.length };
    for (const part of parts) {
      if (part.added) added += part.value.length;
      else if (part.removed) removed += part.value.length;
    }
  }
  return { first: false, added, removed, lines: total, files: changed.length };
}

const parseManifest = (value: unknown): CodeCheckedVersionManifest | null => {
  const parsed = CodeCheckedVersionManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const roleContext = (context: CodeContext) => ({ kind: "request" as const, authority: context.authority });

/** The rows of a version that need a Cloud admin under the current policy, with the rule that decided. */
async function whyRows(owner: CodeOwner, authorId: string | null, rows: readonly CodePolicyRow[]): Promise<CodeAdminWhyRow[]> {
  const policy = await readCodePolicySnapshot();
  const groups = await readCodePolicyGroups(owner.kind === "person" ? owner.userId : authorId);
  const names = await groupNames(groups.groups.map((group) => group.id));
  return rows.flatMap((row) => {
    const result = effective(row, owner, policy.definition, groups);
    return result.value === "admin" ? [{ row, source: result.source, groups: result.groupIds.map((id) => names.get(id) ?? id) }] : [];
  });
}

async function groupNames(ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await sql<{ id: string; name: string }[]>`SELECT id,name FROM auth.groups WHERE id=ANY(${sql.array([...ids], "uuid")})`;
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function userName(id: string | null): Promise<string | null> {
  if (!id) return null;
  const [row] = await sql<{ name: string }[]>`SELECT COALESCE(NULLIF(display_name,''),uid) AS name FROM auth.users WHERE id=${id}::uuid`;
  return row?.name ?? null;
}

/** Counts for the area column. */
export async function readCodeAdminSummary(context: CodeContext): Promise<CodeAdminSummary> {
  requireCodePolicyAdmin(context);
  const [row] = await sql<CodeAdminSummary[]>`SELECT
    (SELECT count(*)::int FROM code.version_submissions s JOIN approvals.requests r ON r.id=s.approval_id
      WHERE r.status='pending' AND r.expires_at>now()) AS approvals,
    (SELECT count(*)::int FROM code.codes) AS codes,
    (SELECT count(DISTINCT group_id)::int FROM code.policy_rules WHERE group_id IS NOT NULL) AS groups,
    (SELECT count(*)::int FROM code.cleanup_jobs) AS cleanup`;
  return row ?? { approvals: 0, codes: 0, groups: 0, cleanup: 0 };
}

/** Open version requests, newest first, bounded to one page. */
export async function listCodeAdminApprovals(
  context: CodeContext,
  page: { cursor?: string } = {},
): Promise<{ items: CodeAdminApproval[]; nextCursor: string | null }> {
  requireCodePolicyAdmin(context);
  const [at, id] = page.cursor?.split("|") ?? [];
  const after = at && id && APPROVAL_CURSOR.test(page.cursor ?? "") ? { at, id } : null;
  const rows = await sql<
    {
      approval_id: string;
      code_id: string;
      version_id: string;
      number: number;
      title: string;
      owner_kind: CodeOwner["kind"];
      owner_user_id: string | null;
      owner_type: string | null;
      owner_id: string | null;
      owner_app_id: string | null;
      author_id: string | null;
      author_name: string | null;
      created_at: Date;
      cursor_time: string;
      source_files: CodeSourceFiles;
      manifest: unknown;
      comparison_files: CodeSourceFiles | null;
    }[]
  >`SELECT to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,s.approval_id,s.code_id,s.version_id,v.number,c.title,c.owner_kind,c.owner_user_id,c.owner_type,c.owner_id,c.owner_app_id,
      v.created_by AS author_id,COALESCE(NULLIF(u.display_name,''),u.uid) AS author_name,r.created_at,v.source_files,v.manifest,
      cmp.source_files AS comparison_files
    FROM code.version_submissions s JOIN approvals.requests r ON r.id=s.approval_id
      JOIN code.versions v ON v.id=s.version_id JOIN code.codes c ON c.id=s.code_id
      LEFT JOIN auth.users u ON u.id=v.created_by
      LEFT JOIN code.versions cmp ON cmp.id=(s.binding->>'comparisonVersionId')::uuid
    WHERE r.status='pending' AND r.expires_at>now()
      AND (${after?.at ?? null}::timestamptz IS NULL OR (r.created_at,r.id) < (${after?.at ?? null}::timestamptz,${after?.id ?? null}::uuid))
    ORDER BY r.created_at DESC,r.id DESC LIMIT ${PAGE + 1}`;
  const deadline = performance.now() + SUMMARY_BUDGET_MS;
  const items: CodeAdminApproval[] = [];
  for (const row of rows.slice(0, PAGE)) {
    const owner = ownerOf(row);
    const manifest = parseManifest(row.manifest);
    items.push({
      approvalId: row.approval_id,
      codeId: row.code_id,
      versionId: row.version_id,
      number: row.number,
      title: row.title,
      author: { id: row.author_id, name: row.author_name },
      submittedAt: iso(row.created_at),
      rows: manifest ? (await whyRows(owner, row.author_id, manifest.policyRows)).map((why) => why.row) : [],
      stat: codeAdminDiffStat(row.comparison_files, row.source_files, deadline),
    });
  }
  const last = rows[PAGE - 1];
  return { items, nextCursor: rows.length > PAGE && last ? `${last.cursor_time}|${last.approval_id}` : null };
}

/** Recently decided versions, including the sole-admin label from C8. */
export async function listCodeAdminDecided(context: CodeContext): Promise<CodeAdminDecided[]> {
  requireCodePolicyAdmin(context);
  const rows = await sql<
    {
      code_id: string;
      version_id: string;
      number: number;
      title: string;
      approved: boolean;
      sole_admin: boolean;
      decided_by: string | null;
      decided_at: Date;
    }[]
  >`SELECT v.code_id,d.version_id,v.number,c.title,d.approved,d.sole_admin,COALESCE(NULLIF(u.display_name,''),u.uid) AS decided_by,d.decided_at
    FROM code.version_decisions d JOIN code.versions v ON v.id=d.version_id JOIN code.codes c ON c.id=v.code_id
      LEFT JOIN auth.users u ON u.id=d.decided_by
    ORDER BY d.decided_at DESC,d.version_id DESC LIMIT ${PAGE}`;
  return rows.map((row) => ({
    codeId: row.code_id,
    versionId: row.version_id,
    number: row.number,
    title: row.title,
    approved: row.approved,
    soleAdmin: row.sole_admin,
    decidedBy: row.decided_by,
    decidedAt: iso(row.decided_at),
  }));
}

type OwnerRow = {
  owner_kind: CodeOwner["kind"];
  owner_user_id: string | null;
  owner_type: string | null;
  owner_id: string | null;
  owner_app_id: string | null;
};
const ownerOf = (row: OwnerRow): CodeOwner =>
  row.owner_kind === "person"
    ? { kind: "person", userId: row.owner_user_id! }
    : row.owner_kind === "resource"
      ? { kind: "resource", ref: { type: row.owner_type!, id: row.owner_id! } }
      : { kind: "app", appId: row.owner_app_id! };

const permissionKey = (permission: { operation: string; target: { type: string; id: string | null } | null }) =>
  `${permission.operation}|${permission.target?.type ?? ""}|${permission.target?.id ?? ""}`;

/** Compare permissions of the reviewed version with the comparison version, deduplicated by operation and target. */
export function codeAdminPermissionChanges(
  current: CodeCheckedVersionManifest["permissions"],
  previous: CodeCheckedVersionManifest["permissions"] | null,
): CodeAdminPermissionChange[] {
  const before = new Map((previous ?? []).map((permission) => [permissionKey(permission), permission]));
  const seen = new Set<string>();
  const changes: CodeAdminPermissionChange[] = [];
  for (const permission of current) {
    const key = permissionKey(permission);
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({ ...permission, change: before.has(key) ? "same" : "added" });
  }
  for (const [key, permission] of before) if (!seen.has(key)) changes.push({ ...permission, change: "removed" });
  const order = { added: 0, same: 1, removed: 2 } as const;
  return changes.sort((a, b) => order[a.change] - order[b.change]);
}

/** Catalog titles of the operations and target types a version names, in the request locale. */
async function operationTitles(
  permissions: readonly { operation: string; target: { type: string } | null }[],
  context: CodeContext,
): Promise<CodeAdminApprovalDetail["titles"]> {
  const titles: CodeAdminApprovalDetail["titles"] = { operations: {}, types: {} };
  const apps = new Set(
    permissions.flatMap((permission) => [permission.operation, permission.target?.type ?? ""].map((id) => id.split(".")[0] ?? "")),
  );
  for (const appId of [...apps].filter(Boolean).slice(0, 20)) {
    const catalog = await getCapabilityCatalogApp(appId, context.locale, context.authority).catch(() => null);
    const manifest = catalog?.ok ? catalog.data?.manifest : null;
    if (!manifest) continue;
    for (const operation of [...manifest.queries, ...manifest.actions])
      titles.operations[`${appId}.${operation.localId}`] = operation.title;
    for (const type of manifest.types ?? []) titles.types[`${appId}.${type.localId}`] = type.title;
  }
  return titles;
}

/** One version for review: the binding, full diff rows, permission changes, and the current decision eligibility. */
export async function readCodeAdminApproval(versionId: string, context: CodeContext): Promise<CodeAdminApprovalDetail> {
  const admin = requireCodePolicyAdmin(context);
  const [row] = await sql<
    (OwnerRow & {
      code_id: string;
      title: string;
      state: Code["state"];
      number: number;
      created_by: string | null;
      created_at: Date;
      manifest: unknown;
      binding: CodeVersionBinding;
      approval_id: string | null;
      request_status: string | null;
      unexpired: boolean | null;
      approved: boolean | null;
      sole_admin: boolean | null;
      decided_by: string | null;
      decided_at: Date | null;
    })[]
  >`SELECT c.id AS code_id,c.title,c.state,c.owner_kind,c.owner_user_id,c.owner_type,c.owner_id,c.owner_app_id,
      v.number,v.created_by,v.created_at,v.manifest,s.binding,s.approval_id,r.status AS request_status,(r.expires_at>now()) AS unexpired,
      d.approved,d.sole_admin,d.decided_by,d.decided_at
    FROM code.versions v JOIN code.codes c ON c.id=v.code_id JOIN code.version_submissions s ON s.version_id=v.id
      LEFT JOIN approvals.requests r ON r.id=s.approval_id LEFT JOIN code.version_decisions d ON d.version_id=v.id
    WHERE v.id=${versionId}::uuid`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code version not found.");
  const owner = ownerOf(row);
  const manifest = parseManifest(row.manifest);
  let files: CodeVersionDiffFile[] | null = null;
  let staleComparison = false;
  try {
    const diff = await diffCodeVersion({ codeId: row.code_id, versionId }, context);
    files = diff.files;
    staleComparison = diff.staleComparison;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    files = null;
  }
  const comparisonId = row.binding.comparisonVersionId;
  const [comparison] = comparisonId
    ? await sql<{ number: number; manifest: unknown; decided_at: Date | null; decided_by: string | null }[]>`
      SELECT v.number,v.manifest,d.decided_at,COALESCE(NULLIF(u.display_name,''),u.uid) AS decided_by FROM code.versions v
        LEFT JOIN code.version_decisions d ON d.version_id=v.id AND d.approved LEFT JOIN auth.users u ON u.id=d.decided_by
      WHERE v.id=${comparisonId}::uuid`
    : [];
  const [newer] = await sql<{ id: string; number: number; author: string | null; created_at: Date }[]>`
    SELECT v.id,v.number,COALESCE(NULLIF(u.display_name,''),u.uid) AS author,v.created_at FROM code.versions v
      LEFT JOIN auth.users u ON u.id=v.created_by
    WHERE v.code_id=${row.code_id} AND v.number>${row.number} ORDER BY v.number DESC LIMIT 1`;
  let canApprove = false;
  let soleAdminNotice: string | null = null;
  const pending = row.request_status === "pending" && row.unexpired === true && row.approved === null;
  if (pending && row.approval_id) {
    const { items } = await listPending({ approverUserId: admin.id, id: row.approval_id, roleContext: roleContext(context), limit: 1 });
    const item = items[0];
    if (item) {
      canApprove = item.canApprove;
      soleAdminNotice = presentPendingApproval(item, [], undefined, context.locale).soleAdminNotice ?? null;
    }
  }
  const permissions = manifest
    ? codeAdminPermissionChanges(manifest.permissions, comparison ? (parseManifest(comparison.manifest)?.permissions ?? []) : null)
    : [];
  const [authorName, ownerName, decidedByName] = await Promise.all([
    userName(row.created_by),
    owner.kind === "person" ? userName(owner.userId) : Promise.resolve(null),
    userName(row.decided_by),
  ]);
  return {
    approvalId: row.approval_id,
    status:
      row.approved === true
        ? "approved"
        : row.approved === false
          ? "rejected"
          : row.approval_id === null
            ? "submitted"
            : pending
              ? "pending"
              : row.request_status === "cancelled"
                ? "cancelled"
                : "expired",
    code: { id: row.code_id, title: row.title, owner, state: row.state },
    ownerName,
    version: { id: versionId, number: row.number, submittedAt: iso(row.created_at), author: { id: row.created_by, name: authorName } },
    binding: row.binding,
    comparison:
      comparisonId && comparison
        ? {
            versionId: comparisonId,
            number: comparison.number,
            decidedAt: comparison.decided_at ? iso(comparison.decided_at) : null,
            decidedBy: comparison.decided_by,
          }
        : null,
    files,
    staleComparison,
    permissions,
    why: manifest ? await whyRows(owner, row.created_by, manifest.policyRows) : [],
    ai: manifest?.ai ?? false,
    newer: newer ? { versionId: newer.id, number: newer.number, author: newer.author, submittedAt: iso(newer.created_at) } : null,
    canApprove,
    own: row.created_by === admin.id,
    soleAdminNotice,
    decision: row.decided_at
      ? {
          approved: row.approved === true,
          soleAdmin: row.sole_admin === true,
          decidedBy: row.decided_by,
          decidedAt: iso(row.decided_at),
          label: "",
          decidedByName,
        }
      : null,
    titles: await operationTitles(permissions, context),
  };
}

type CodeListRow = OwnerRow & {
  id: string;
  title: string;
  state: Code["state"];
  pause_reason: string | null;
  owner_name: string | null;
  waiting: boolean;
  last_run_at: Date | null;
  last_run_state: CodeRun["state"] | null;
  created_at: Date;
  active_number: number | null;
};
const mapListRow = (row: CodeListRow): CodeAdminCode => ({
  id: row.id,
  title: row.title,
  owner: ownerOf(row),
  ownerName: row.owner_name,
  state: row.state,
  status: row.state === "deleting" ? "deleting" : row.waiting ? "waiting" : row.state,
  pauseReason: row.pause_reason,
  lastRun: row.last_run_at && row.last_run_state ? { at: iso(row.last_run_at), state: row.last_run_state } : null,
});
const codeListBase =
  () => sql`SELECT c.id,c.title,c.state,c.pause_reason,c.created_at,c.owner_kind,c.owner_user_id,c.owner_type,c.owner_id,c.owner_app_id,
    COALESCE(NULLIF(u.display_name,''),u.uid) AS owner_name,
    EXISTS(SELECT 1 FROM code.version_submissions s JOIN approvals.requests r ON r.id=s.approval_id
      WHERE s.code_id=c.id AND r.status='pending' AND r.expires_at>now()) AS waiting,
    last.created_at AS last_run_at,last.state AS last_run_state,active.number AS active_number
  FROM code.codes c LEFT JOIN auth.users u ON u.id=c.owner_user_id
    LEFT JOIN LATERAL (SELECT created_at,state FROM code.runs r WHERE r.code_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) last ON true
    LEFT JOIN code.versions active ON active.id=c.active_version_id`;
const codeListSelect =
  () => sql`SELECT b.*,CASE WHEN b.state='deleting' THEN 'deleting' WHEN b.waiting THEN 'waiting' ELSE b.state END AS status
  FROM (${codeListBase()}) b`;

/** All Code of this installation, title-ordered with an opaque cursor. Cloud admins see every Code (modell 7). */
export async function listCodeAdminCodes(
  filter: CodeAdminCodeFilter & { cursor?: string },
  context: CodeContext,
): Promise<{ items: CodeAdminCode[]; total: number; owners: number; nextCursor: string | null }> {
  requireCodePolicyAdmin(context);
  const after = filter.cursor ? decodeCodeAdminCursor(filter.cursor) : null;
  const status = filter.status ?? null;
  const app = filter.app ?? null;
  const q = filter.q?.trim() ? `%${filter.q.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
  const where = () => sql`(${status}::text IS NULL OR x.status=${status})
    AND (${app}::text IS NULL OR (${app}='person' AND x.owner_kind='person') OR x.owner_app_id=${app} OR split_part(x.owner_type,'.',1)=${app})
    AND (${q}::text IS NULL OR x.title ILIKE ${q} OR x.owner_name ILIKE ${q})`;
  const rows = await sql<CodeListRow[]>`SELECT * FROM (${codeListSelect()}) x WHERE ${where()}
    AND (${after?.title ?? null}::text IS NULL OR (lower(x.title),x.id) > (lower(${after?.title ?? null}),${after?.id ?? null}))
    ORDER BY lower(x.title),x.id LIMIT ${PAGE + 1}`;
  const [count] = await sql<{ total: number; owners: number }[]>`SELECT count(*)::int AS total,
      count(DISTINCT COALESCE(x.owner_user_id::text,x.owner_type||':'||x.owner_id,x.owner_app_id))::int AS owners
    FROM (${codeListSelect()}) x WHERE ${where()}`;
  const items = rows.slice(0, PAGE).map(mapListRow);
  const last = items.at(-1);
  return {
    items,
    total: count?.total ?? 0,
    owners: count?.owners ?? 0,
    nextCursor: rows.length > PAGE && last ? encodeCodeAdminCursor({ title: last.title, id: last.id }) : null,
  };
}
export const encodeCodeAdminCursor = (value: { title: string; id: string }) => Buffer.from(JSON.stringify(value)).toString("base64url");
export const decodeCodeAdminCursor = (value: string): { title: string; id: string } | null => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    return parsed && typeof parsed === "object" && "title" in parsed && "id" in parsed
      ? { title: String(parsed.title), id: String(parsed.id) }
      : null;
  } catch {
    return null;
  }
};

/** One Code for the detail column: versions with decisions, recent runs and pending cleanup. */
export async function readCodeAdminCode(codeId: string, context: CodeContext): Promise<CodeAdminCodeDetail> {
  requireCodePolicyAdmin(context);
  const [row] = await sql<CodeListRow[]>`SELECT * FROM (${codeListSelect()}) x WHERE x.id=${codeId}`;
  if (!row) throw new CodeDataError("NOT_FOUND", "Code not found.");
  const [versions, runs, cleanup, pending] = await Promise.all([
    listCodeVersions({ codeId, limit: 10 }, context),
    listCodeRuns({ codeId, limit: 10 }, context),
    listCodeCleanupJobs({ codeId, limit: 20 }, context),
    sql<{ version_id: string }[]>`SELECT s.version_id FROM code.version_submissions s JOIN approvals.requests r ON r.id=s.approval_id
      WHERE s.code_id=${codeId} AND r.status='pending' AND r.expires_at>now() LIMIT 1`,
  ]);
  return {
    code: { ...mapListRow(row), activeVersionNumber: row.active_number, createdAt: iso(row.created_at) },
    versions: versions.items,
    runs: runs.items,
    cleanup: cleanup.items,
    pendingVersionId: pending[0]?.version_id ?? null,
  };
}

/** The policy with group names and usage per classification, for the editor. */
export async function readCodeAdminPolicy(context: CodeContext): Promise<CodeAdminPolicy> {
  requireCodePolicyAdmin(context);
  return sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    const policy = await readCodePolicySnapshot(tx);
    const usageRows = await tx<{ row: string; count: number }[]>`SELECT row,count(DISTINCT c.id)::int AS count
      FROM code.codes c JOIN code.versions v ON v.id=c.active_version_id
        CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(v.manifest->'policyRows')='array' THEN v.manifest->'policyRows' ELSE '[]'::jsonb END) row
      WHERE c.state IN ('active','paused') GROUP BY row`;
    const ruleGroups = [...new Set(policy.definition.rules.flatMap((rule) => (rule.groupId ? [rule.groupId] : [])))];
    const groups = ruleGroups.length
      ? await tx<{ id: string; name: string; members: number; parents: string[] }[]>`SELECT g.id,g.name,
          (SELECT count(*)::int FROM auth.user_groups_v2 m WHERE m.group_id=g.id) AS members,
          ARRAY(SELECT p.name FROM auth.group_groups_v2 e JOIN auth.groups p ON p.id=e.parent_group_id AND p.provider=g.provider
            WHERE e.child_group_id=g.id ORDER BY p.name) AS parents
        FROM auth.groups g WHERE g.id=ANY(${tx.array(ruleGroups, "uuid")}) ORDER BY lower(g.name)`
      : [];
    const [updatedBy] = policy.updatedBy
      ? await tx<
          { name: string }[]
        >`SELECT COALESCE(NULLIF(display_name,''),uid) AS name FROM auth.users WHERE id=${policy.updatedBy}::uuid`
      : [];
    const usage: Partial<Record<CodePolicyRow, number>> = {};
    for (const entry of usageRows) {
      const row = CodePolicyRowSchema.safeParse(entry.row);
      if (row.success) usage[row.data] = entry.count;
    }
    return {
      policy,
      updatedByName: updatedBy?.name ?? null,
      usage,
      groups: groups.map((group) => ({
        ...group,
        rules: policy.definition.rules.filter((rule) => rule.groupId === group.id).length,
      })),
    };
  });
}

/** The effective table for one person, with group names for the deciding rule. */
export async function readCodeAdminEffective(userId: string, context: CodeContext): Promise<CodeAdminEffective> {
  requireCodePolicyAdmin(context);
  const name = await userName(userId);
  if (!name) throw new CodeDataError("NOT_FOUND", "Person not found.");
  const policy = await readCodePolicySnapshot();
  const membership = await readCodePolicyGroups(userId);
  const names = await groupNames([
    ...new Set([...membership.groups.map((group) => group.id), ...membership.ancestors.map((edge) => edge.ancestorId)]),
  ]);
  const owner: CodeOwner = { kind: "person", userId };
  return {
    person: { id: userId, name },
    groups: membership.groups.map((group) => ({
      id: group.id,
      name: names.get(group.id) ?? group.id,
      parents: membership.ancestors
        .filter((edge) => edge.groupId === group.id && edge.ancestorId !== group.id)
        .map((edge) => names.get(edge.ancestorId) ?? edge.ancestorId),
    })),
    rows: CODE_POLICY_ROWS.map((row) => {
      const result = effective(row, owner, policy.definition, membership);
      return { row, value: result.value, source: result.source, groups: result.groupIds.map((id) => names.get(id) ?? id) };
    }),
  };
}

/** Waiting cleanup jobs (C10) across all Code. */
export async function listCodeAdminCleanup(
  context: CodeContext,
  page: { cursor?: string } = {},
): Promise<{ items: CodeCleanupJob[]; nextCursor: string | null }> {
  return listCodeCleanupJobs({ limit: 50, ...(page.cursor ? { cursor: page.cursor } : {}) }, context);
}

/** Runner capacity (C13) for the replaceable runner section. */
export async function readCodeAdminRunners(context: CodeContext): Promise<CodeRunnerMetrics> {
  requireCodePolicyAdmin(context);
  return readCodeRunnerMetrics(context, { limit: 50 });
}

/** Owner names for policy impact items, so the confirmation names who is affected. */
export async function codeAdminOwnerNames(codeIds: readonly string[], context: CodeContext): Promise<Record<string, string | null>> {
  requireCodePolicyAdmin(context);
  if (!codeIds.length) return {};
  const rows = await sql<{ id: string; name: string | null }[]>`SELECT c.id,
      CASE WHEN c.owner_kind='person' THEN COALESCE(NULLIF(u.display_name,''),u.uid) ELSE NULL END AS name
    FROM code.codes c LEFT JOIN auth.users u ON u.id=c.owner_user_id WHERE c.id=ANY(${sql.array([...codeIds], "text")})`;
  return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}
