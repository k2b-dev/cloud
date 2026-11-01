import { sql } from "@k2b/cloud";
import { audit, canRepairAppAccess } from "@k2b/cloud/services";
import type { SQL } from "bun";
import type { z } from "zod";
import { type CodeContext, CodeDataError, codePerson } from "./access";
import type { CodeOwner } from "./contracts";
import {
  CODE_POLICY_ROWS,
  type CodePolicy,
  type CodePolicyDefinition,
  CodePolicyDefinitionSchema,
  type CodePolicyImpactSchema,
  CodePolicyManifestSchema,
  type CodePolicyRow,
  CodePolicyRowSchema,
  CodePolicySchema,
  type CodePolicyValue,
  type codePolicyContracts,
} from "./policy-contracts";
import { type CodePolicyGroups, effective } from "./policy-effective";

/** Policy administration requires a full Cloud-admin credential; phone sessions cannot change it. */
export function requireCodePolicyAdmin(context: CodeContext, write = false) {
  const user = codePerson(context, write);
  if (!user.roles.includes("admin") || (write && !canRepairAppAccess(context.authority)))
    throw new CodeDataError("FORBIDDEN", "Cloud Code administration authority is required.");
  return user;
}
/** One authoritative statement binds revision to rules. Callers control the shared policy/group snapshot with transaction isolation. No cache. */
export async function readCodePolicySnapshot(db: SQL = sql): Promise<CodePolicy> {
  const [row] = await db<{ revision: number; preset: string; updated_by: string | null; updated_at: Date; rules: unknown }[]>`
    SELECT p.*, COALESCE((SELECT jsonb_agg(jsonb_build_object('groupId',group_id,'row',row,'value',value)
      ORDER BY group_id NULLS FIRST,row) FROM code.policy_rules),'[]'::jsonb) AS rules
    FROM code.policy p WHERE singleton`;
  if (!row) throw new Error("Code policy unavailable");
  return CodePolicySchema.parse({
    revision: row.revision,
    definition: { preset: row.preset, rules: row.rules },
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  });
}
/** Current same-provider ancestry, using UNION to terminate cycles. IPA effective memberships are peers. */
export async function readCodePolicyGroups(userId: string | null, db: SQL = sql): Promise<CodePolicyGroups> {
  if (!userId) return { groups: [], ancestors: [] };
  const rows = await db<{ id: string; provider: string; ancestor_id: string }[]>`
    WITH RECURSIVE members(id) AS (
      SELECT group_id FROM auth.user_groups_v2 WHERE user_id=${userId}::uuid
      UNION SELECT g.id FROM auth.ipa_user_effective_groups m JOIN auth.groups g ON g.provider='ipa' AND g.name=m.group_name
        WHERE m.user_id=${userId}::uuid
      UNION SELECT edge.parent_group_id FROM members m JOIN auth.groups child ON child.id=m.id
        JOIN auth.group_groups_v2 edge ON edge.child_group_id=m.id
        JOIN auth.groups parent ON parent.id=edge.parent_group_id AND parent.provider=child.provider
        WHERE child.provider<>'ipa'
    ), ancestry(id,ancestor_id) AS (
      SELECT id,id FROM members
      UNION SELECT a.id,edge.parent_group_id FROM ancestry a JOIN auth.groups child ON child.id=a.ancestor_id
        JOIN auth.group_groups_v2 edge ON edge.child_group_id=a.ancestor_id
        JOIN auth.groups parent ON parent.id=edge.parent_group_id AND parent.provider=child.provider
        WHERE child.provider<>'ipa'
    ) SELECT a.id,g.provider,a.ancestor_id FROM ancestry a JOIN auth.groups g ON g.id=a.id`;
  return {
    groups: [...new Map(rows.map((row) => [row.id, { id: row.id, provider: row.provider }])).values()],
    ancestors: rows.map((row) => ({ groupId: row.id, ancestorId: row.ancestor_id })),
  };
}
const snapshot = <T>(run: (db: SQL) => Promise<T>) =>
  sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    return run(tx);
  });
/** Own view includes only applicable group rules; admins read the complete editable table. */
export async function readCodePolicy(context: CodeContext) {
  const user = codePerson(context);
  return snapshot(async (db) => {
    const policy = await readCodePolicySnapshot(db);
    if (!user.roles.includes("admin")) {
      const membership = await readCodePolicyGroups(user.id, db);
      const ids = new Set(membership.groups.map((group) => group.id));
      policy.definition.rules = policy.definition.rules.filter((rule) => rule.groupId === null || ids.has(rule.groupId));
    }
    return { policy };
  });
}
/** Resolve all rows for a personal owner or a resource/app author. Other people's views require Cloud administration. */
export async function effectiveCodePolicy(input: z.infer<typeof codePolicyContracts.effective.input>, context: CodeContext) {
  const user = codePerson(context);
  const owner = input.owner ?? { kind: "person" as const, userId: user.id };
  if (owner.kind !== "person" || owner.userId !== user.id || (input.authorId && input.authorId !== user.id))
    requireCodePolicyAdmin(context);
  return snapshot(async (db) => {
    const policy = await readCodePolicySnapshot(db);
    const groups = await readCodePolicyGroups(owner.kind === "person" ? owner.userId : (input.authorId ?? null), db);
    return { revision: policy.revision, rows: CODE_POLICY_ROWS.map((row) => effective(row, owner, policy.definition, groups)) };
  });
}

/** C8 calls only after verifying and recording a Cloud-admin approval of this immutable version, in that same transaction.
 * Locks the owning Code; callers that read policy must lock policy first.
 * This internal storage seam grants no activation or execution authority. Rejection/revocation removes coverage.
 */
export async function replaceCodePolicyCoverage(versionId: string, rows: readonly CodePolicyRow[], db: SQL): Promise<void> {
  for (const row of rows) CodePolicyRowSchema.parse(row);
  const code = await db`SELECT c.id FROM code.codes c JOIN code.versions v ON v.code_id=c.id
    WHERE v.id=${versionId}::uuid FOR UPDATE OF c`;
  if (!code.length) throw new CodeDataError("NOT_FOUND", "Code version not found.");
  await db`DELETE FROM code.policy_coverage WHERE version_id=${versionId}::uuid`;
  for (const row of new Set(rows)) await db`INSERT INTO code.policy_coverage(version_id,row) VALUES(${versionId}::uuid,${row})`;
}

type Candidate = {
  id: string;
  title: string;
  owner_kind: CodeOwner["kind"];
  owner_user_id: string | null;
  owner_type: string | null;
  owner_id: string | null;
  owner_app_id: string | null;
  active_version_id: string | null;
  author_id: string | null;
  manifest: unknown;
  coverage: string[];
};
const ownerFor = (row: Candidate): CodeOwner =>
  row.owner_kind === "person"
    ? { kind: "person", userId: row.owner_user_id! }
    : row.owner_kind === "app"
      ? { kind: "app", appId: row.owner_app_id! }
      : { kind: "resource", ref: { type: row.owner_type!, id: row.owner_id! } };
/** Shared preview/worker decision: only newly stricter rows lacking approval pause; a loosening never pauses. */
export async function codePolicyImpact(
  candidate: Candidate,
  before: CodePolicyDefinition,
  after: CodePolicyDefinition,
  db: SQL,
  membership?: CodePolicyGroups,
): Promise<z.infer<typeof CodePolicyImpactSchema> | null> {
  const owner = ownerFor(candidate);
  const groups = membership ?? (await readCodePolicyGroups(owner.kind === "person" ? owner.userId : candidate.author_id, db));
  const manifest = CodePolicyManifestSchema.safeParse(candidate.manifest);
  // Active versions without checker classifications cannot be established as allowed.
  const used = manifest.success ? new Set(manifest.data.policyRows) : new Set(CODE_POLICY_ROWS);
  const rank = { automatic: 0, admin: 1, never: 2 };
  const rows = [...used].filter((row) => {
    const oldValue = effective(row, owner, before, groups).value;
    const newValue = effective(row, owner, after, groups).value;
    return rank[newValue] > rank[oldValue] && (newValue === "never" || !candidate.coverage.includes(row));
  });
  return rows.length
    ? { codeId: candidate.id, title: candidate.title, rows, reason: manifest.success ? "policy_changed" : "policy_rows_unavailable" }
    : null;
}
/** Bounded candidate page. Lock rows when pausing, so an activation cannot race the evaluated version. */
export async function codePolicyCandidates(db: SQL, cursor: string | null, limit: number, lock = false): Promise<Candidate[]> {
  // Read the joined immutable version only after the Code locks are held. A lock wait
  // must not leave a pre-activation join snapshot attached to a newly active version.
  const locked = lock
    ? await db<{ id: string }[]>`SELECT id FROM code.codes
    WHERE state='active' AND (${cursor}::text IS NULL OR id>${cursor}) ORDER BY id LIMIT ${limit} FOR UPDATE`
    : null;
  if (locked && !locked.length) return [];
  return db<Candidate[]>`SELECT c.id,c.title,c.owner_kind,c.owner_user_id,c.owner_type,c.owner_id,c.owner_app_id,c.active_version_id,
    v.created_by AS author_id,v.manifest,
    ARRAY(SELECT row FROM code.policy_coverage WHERE version_id=v.id) AS coverage
    FROM code.codes c LEFT JOIN code.versions v ON v.id=c.active_version_id
    WHERE c.state='active' AND (${cursor}::text IS NULL OR c.id>${cursor})
    ${
      locked
        ? db`AND c.id=ANY(${db.array(
            locked.map((row) => row.id),
            "text",
          )})`
        : db``
    }
    ORDER BY c.id LIMIT ${limit}`;
}
/** One bounded-memory scan supplies a count and an affected-only page. Membership cache is bounded by the 50-Code batch budget. */
async function scanCodePolicyImpacts(
  before: CodePolicyDefinition,
  after: CodePolicyDefinition,
  db: SQL,
  input: { cursor?: string; limit: number },
  context: CodeContext,
) {
  const items: z.infer<typeof CodePolicyImpactSchema>[] = [];
  const memberships = new Map<string | null, CodePolicyGroups>();
  let cursor: string | null = null;
  let total = 0;
  let more = false;
  while (true) {
    context.signal?.throwIfAborted();
    const batch = await codePolicyCandidates(db, cursor, 50);
    for (const candidate of batch) {
      context.signal?.throwIfAborted();
      const userId = candidate.owner_kind === "person" ? candidate.owner_user_id : candidate.author_id;
      let membership = memberships.get(userId);
      if (!membership) {
        membership = await readCodePolicyGroups(userId, db);
        if (memberships.size === 50) memberships.delete(memberships.keys().next().value ?? null);
        memberships.set(userId, membership);
      }
      const impact = await codePolicyImpact(candidate, before, after, db, membership);
      if (!impact) continue;
      total++;
      if (!input.cursor || impact.codeId > input.cursor) {
        if (items.length < input.limit) items.push(impact);
        else more = true;
      }
    }
    if (batch.length < 50) break;
    cursor = batch.at(-1)!.id;
  }
  return { total, items, nextCursor: more ? (items.at(-1)?.codeId ?? null) : null };
}
/** Preview uses a consistent snapshot, with an exact total and a bounded page of affected Codes. */
export async function previewCodePolicy(input: z.infer<typeof codePolicyContracts.preview.input>, context: CodeContext) {
  requireCodePolicyAdmin(context);
  const definition = CodePolicyDefinitionSchema.parse(input.definition);
  return snapshot(async (db) => {
    const policy = await readCodePolicySnapshot(db);
    if (policy.revision !== input.revision) throw new CodeDataError("CONFLICT", "Code policy changed; read and preview it again.");
    return { revision: policy.revision, ...(await scanCodePolicyImpacts(policy.definition, definition, db, input, context)) };
  });
}
/** Audit dictionaries preserve all changes without the audit service's 50-item array truncation. */
function policyChanges(before: CodePolicyDefinition, after: CodePolicyDefinition) {
  const changes: Record<string, Partial<Record<CodePolicyRow, { before: CodePolicyValue | null; after: CodePolicyValue | null }>>> = {};
  for (const rule of [...before.rules, ...after.rules]) {
    const previous = before.rules.find((old) => old.groupId === rule.groupId && old.row === rule.row)?.value ?? null;
    const next = after.rules.find((item) => item.groupId === rule.groupId && item.row === rule.row)?.value ?? null;
    if (previous !== next) {
      const key = rule.groupId ?? "default";
      changes[key] ??= {};
      changes[key][rule.row] = { before: previous, after: next };
    }
  }
  return changes;
}
/** Atomically replace the table using optimistic concurrency, and enqueue a durable batch pause scan. */
export async function updateCodePolicy(input: z.infer<typeof codePolicyContracts.update.input>, context: CodeContext) {
  const user = requireCodePolicyAdmin(context, true);
  const definition = CodePolicyDefinitionSchema.parse(input.definition);
  return sql.begin(async (tx) => {
    await tx`SELECT singleton FROM code.policy WHERE singleton FOR UPDATE`;
    const previous = await readCodePolicySnapshot(tx);
    if (previous.revision !== input.revision) throw new CodeDataError("CONFLICT", "Code policy changed; read and preview it again.");
    const ids = [...new Set(definition.rules.flatMap((rule) => (rule.groupId ? [rule.groupId] : [])))];
    if (ids.length) {
      const found = await tx`SELECT id FROM auth.groups WHERE id=ANY(${tx.array(ids, "uuid")}) FOR KEY SHARE`;
      if (found.length !== ids.length) throw new CodeDataError("BAD_INPUT", "Policy group not found.");
    }
    const changes = policyChanges(previous.definition, definition);
    const expectedPauseCount = Object.keys(changes).length
      ? (await scanCodePolicyImpacts(previous.definition, definition, tx, { limit: 0 }, context)).total
      : 0;
    await tx`DELETE FROM code.policy_rules`;
    for (const rule of definition.rules)
      await tx`INSERT INTO code.policy_rules(group_id,row,value) VALUES(${rule.groupId}::uuid,${rule.row},${rule.value})`;
    await tx`UPDATE code.policy SET revision=revision+1,preset=${definition.preset},updated_by=${user.id}::uuid,updated_at=clock_timestamp() WHERE singleton`;
    const policy = await readCodePolicySnapshot(tx);
    const [job] = await tx<
      { id: string }[]
    >`INSERT INTO code.policy_pause_outbox(revision,previous) VALUES(${policy.revision},${JSON.stringify(previous.definition)}::jsonb) RETURNING id`;
    const actor = context.authority.actor;
    await audit.record(
      {
        action: "core.code.policy.updated",
        outcome: "allowed",
        actor:
          actor.kind === "user"
            ? { userId: actor.user.id, uid: actor.user.uid, provider: actor.user.provider, roles: actor.user.roles }
            : { uid: `service-account:${actor.serviceAccount.id}`, provider: "service_account", roles: actor.scopes },
        target: { type: "code.policy", id: "default" },
        requestId: context.requestId,
        metadata: {
          revision: policy.revision,
          previousRevision: previous.revision,
          preset: policy.definition.preset,
          previousPreset: previous.definition.preset,
          pauseJobId: job!.id,
          changes,
          expectedPauseCount,
        },
      },
      tx,
    );
    return { policy, pauseJobId: job!.id };
  });
}
