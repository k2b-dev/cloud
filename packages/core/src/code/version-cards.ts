import { sql } from "@k2b/cloud";
import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import { CodeCheckedVersionManifestSchema, cloudResourceRefAppId } from "@k2b/cloud/contracts";
import { type CodeVersionCardSnapshot, type CodeVersionCards, codeVersionCardsContract } from "@k2b/cloud/contracts/code-version-cards";
import { isAppSessionActor } from "@k2b/cloud/server";
import type { z } from "zod";
import {
  type CodeContext,
  CodeDataError,
  CodeOwnerUnavailableError,
  codePerson,
  isCodePageMember,
  readCodeOwner,
  requireCodePermission,
} from "./access";
import { describeCodePages } from "./page-links";
import { readCodePolicyGroups, readCodePolicySnapshot } from "./policy";
import { readModelNames } from "./read-model/names";
import { presentCodeVersion } from "./read-model/present";
import { CodeReviewRevisionSchema, CodeSubmissionOriginSchema } from "./review-contracts";
import { type CodeRow, mapCode } from "./store";
import { fillCodeVersionCardPage } from "./version-card-page";
import {
  assertCodeVersionApprovalEvidence,
  type CodeVersionApprovalEvidence,
  CodeVersionError,
  pendingCodeVersionReadiness,
} from "./versions";

type VersionRow = {
  id: string;
  code_id: string;
  number: number;
  manifest: unknown;
  created_at: Date;
  created_by: string | null;
  source_hash: string;
  bundle_hash: string;
  submitted: boolean;
  decision: CodeVersionApprovalEvidence["decision"];
  latest_id: string;
  latest_number: number;
  running_number: number | null;
  approval_id: string | null;
  approval_status: string | null;
  unexpired: boolean | null;
  origin: unknown;
  withdrawn: boolean;
  outcome: "approved" | "changes_requested" | "rejected" | null;
  comment: string | null;
  decided_by: string | null;
  name: string | null;
  avatar_hash: string | null;
  comment_count: number;
  revision: unknown;
};

/** The Code page's read permission, word projection and page selector, without its expensive detail refresh. */
export async function readCodeVersionCards(
  raw: z.input<typeof codeVersionCardsContract.input>,
  outerContext: CodeContext,
): Promise<CodeVersionCards> {
  const input = codeVersionCardsContract.input.parse(raw);
  const viewer = codePerson(outerContext);
  const requested = [...new Map(input.versions.map((version) => [`${version.codeId}:${version.versionId}`, version])).values()];
  const codes = await sql<(CodeRow & { paused_by_name: string | null })[]>`SELECT c.*,
    COALESCE(NULLIF(trim(u.display_name),''),NULLIF(trim(concat_ws(' ',u.given_name,u.sn)),'')) AS activated_by_name,
    (SELECT COALESCE(NULLIF(trim(p.display_name),''),p.uid) FROM audit.events e JOIN auth.users p ON p.id=e.actor_user_id
      WHERE e.target_type='code' AND e.target_id=c.id AND e.action='core.code.paused' AND e.outcome='allowed'
        AND c.state='paused' AND c.pause_reason='manual' AND e.created_at=c.paused_at
        AND (${viewer.roles.includes("user")} OR e.actor_user_id=${viewer.id}::uuid) ORDER BY e.id DESC LIMIT 1) AS paused_by_name
    FROM code.codes c LEFT JOIN auth.users u ON u.id=c.activated_by WHERE c.id=ANY(${sql.array([...new Set(requested.map((v) => v.codeId))], "text")}::text[])`;
  // Authorization is per Code, not per historical version. Answers are request-local and never survive a refresh.
  const allowed = new Map<
    string,
    {
      code: ReturnType<typeof mapCode>;
      permission: "reader" | "editor";
      context: CodeContext;
      activatedById: string | null;
      pausedByName: string | null;
    }
  >();
  const deferred = new Set<string>();
  const failed = new Set<string>();
  const ownerAnswers = new Map<string, { context: CodeContext; answer: Awaited<ReturnType<typeof readCodeOwner>> }>();
  let ownerQueryUsed = false;
  class OwnerBudgetReached extends Error {}
  const readOwner: typeof readCodeOwner = async (owner, context) => {
    if (owner.kind !== "resource") return readCodeOwner(owner, context);
    const key = JSON.stringify(owner.ref);
    const previous = ownerAnswers.get(key);
    if (previous) {
      context.ownerReaderAnswer = previous.context.ownerReaderAnswer;
      return previous.answer;
    }
    if (context.authority.credentialKind === "invocation") {
      if (ownerQueryUsed) throw new OwnerBudgetReached();
      if (!context.query || context.authority.actor.delegation?.parentInvocationId)
        throw new CodeOwnerUnavailableError("Code owner reader unavailable");
      ownerQueryUsed = true;
    }
    const answer = await readCodeOwner(owner, context);
    ownerAnswers.set(key, { context, answer });
    return answer;
  };
  for (const row of codes) {
    const code = mapCode(row, viewer),
      context: CodeContext = { ...outerContext, ownerReaderAnswer: null };
    try {
      if (code.state === "deleting") continue;
      const permission = await requireCodePermission(code, context, false, sql, readOwner);
      allowed.set(code.id, { code, permission, context, activatedById: row.activated_by ?? null, pausedByName: row.paused_by_name });
    } catch (error) {
      if (error instanceof OwnerBudgetReached) {
        deferred.add(code.id);
        continue;
      }
      if (error instanceof CodeOwnerUnavailableError) {
        failed.add(code.id);
        continue;
      }
      if (!(error instanceof CodeDataError) || !["NOT_FOUND", "FORBIDDEN"].includes(error.code)) throw error;
    }
  }
  const readable = requested.filter((v) => allowed.has(v.codeId));
  const rows = readable.length
    ? await sql<VersionRow[]>`SELECT v.id,v.code_id,v.number,v.manifest,v.created_at,v.created_by,v.source_hash,v.bundle_hash,
    (s.version_id IS NOT NULL) AS submitted,
    CASE WHEN d.version_id IS NULL THEN NULL ELSE jsonb_build_object('approved',d.approved,'binding',d.binding,'valid',
      COALESCE(u.auth_epoch=d.auth_epoch AND (d.decided_device_id IS NULL OR EXISTS
        (SELECT 1 FROM auth.app_devices device WHERE device.id=d.decided_device_id AND device.user_id=d.decided_by AND device.revoked_at IS NULL)),false)) END AS decision,
    newest.id AS latest_id,newest.number AS latest_number,active.number AS running_number,
    s.approval_id,s.origin,r.status AS approval_status,(r.expires_at>now()) AS unexpired,
    EXISTS(SELECT 1 FROM code.version_withdrawals w WHERE w.version_id=v.id) AS withdrawn,
    d.outcome,d.comment,d.decided_by,COALESCE(NULLIF(u.display_name,''),u.uid) AS name,u.avatar_hash,
    (SELECT count(*)::int FROM code.version_comments comments WHERE comments.version_id=v.id) AS comment_count,
    (SELECT jsonb_build_object('state',w.state,'reason',w.reason,'turnId',w.turn_id,'submittedVersionId',w.submitted_version_id,'submittedNumber',next.number)
      FROM code.review_chat_work w LEFT JOIN code.versions next ON next.id=w.submitted_version_id WHERE w.version_id=v.id) AS revision
    FROM code.versions v JOIN code.codes c ON c.id=v.code_id
    JOIN LATERAL (SELECT id,number FROM code.versions WHERE code_id=v.code_id ORDER BY number DESC LIMIT 1) newest ON true
    LEFT JOIN code.versions active ON active.id=c.active_version_id
    LEFT JOIN code.version_submissions s ON s.version_id=v.id
    LEFT JOIN approvals.requests r ON r.id=s.approval_id
    LEFT JOIN code.version_decisions d ON d.version_id=v.id
    LEFT JOIN auth.users u ON u.id=d.decided_by
    WHERE v.id=ANY(${sql.array(
      readable.map((v) => v.versionId),
      "uuid",
    )}::uuid[])
      AND v.code_id=ANY(${sql.array([...allowed.keys()], "text")}::text[])`
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const manifests = rows.map((row) => CodeCheckedVersionManifestSchema.parse(row.manifest));
  const ownerContext = [...ownerAnswers.values()].find((item) => item.context.ownerReaderAnswer)?.context;
  const names = await readModelNames(manifests, {
    ...outerContext,
    ownerReaderAnswer: ownerContext?.ownerReaderAnswer ?? null,
    query: ownerQueryUsed ? undefined : outerContext.query,
  });
  const needsReadiness = rows.some((row) => row.number === row.latest_number && allowed.get(row.code_id)?.code.activeVersionId !== row.id);
  const policy = needsReadiness ? await readCodePolicySnapshot(sql) : null;
  const memberships = new Map<string, ReturnType<typeof readCodePolicyGroups>>();
  const groupsFor = (userId: string | null) => {
    const key = userId ?? "";
    let groups = memberships.get(key);
    if (!groups) {
      groups = readCodePolicyGroups(userId, sql);
      memberships.set(key, groups);
    }
    return groups;
  };
  const knownPages = new Set(input.knownPages);
  const { authority } = outerContext;
  const credentialKind = authority.credentialKind === "invocation" ? authority.actor.delegation?.credentialKind : authority.credentialKind;
  const mayOpen = isCodePageMember({ ...authority, credentialKind: credentialKind === "session" ? "session" : undefined });
  const pagesByCode = new Map<string, Promise<string | null>>();
  const pageOf = (code: ReturnType<typeof mapCode>) => {
    if (code.owner.kind !== "resource") return Promise.resolve(null);
    const ref = code.owner.ref,
      appId = cloudResourceRefAppId(ref);
    let page = pagesByCode.get(code.id);
    if (!page) {
      page = getCapabilityCatalogApp(appId, outerContext.locale, authority).then((answer) => {
        const pattern = answer.ok ? answer.data?.manifest.code?.pages?.[ref.type.slice(appId.length + 1)] : null;
        return pattern ? pattern.replace("{id}", encodeURIComponent(ref.id)) : null;
      });
      pagesByCode.set(code.id, page);
    }
    return page;
  };
  const items: CodeVersionCards["items"] = [];
  for (const ref of requested) {
    const access = allowed.get(ref.codeId),
      row = byId.get(ref.versionId);
    if (deferred.has(ref.codeId)) continue;
    if (failed.has(ref.codeId)) {
      items.push({ ...ref, state: "failed" });
      continue;
    }
    if (!access || !row || row.code_id !== ref.codeId) {
      items.push({ ...ref, state: "denied" });
      continue;
    }
    const { code, permission, context } = access;
    const manifest = CodeCheckedVersionManifestSchema.parse(row.manifest);
    // Readers see a receipt, not editor-only review messages or controls. Admin access to another person's Code is a reader grant.
    let canManage = permission === "editor";
    try {
      codePerson(context, true);
    } catch (error) {
      if (!(error instanceof CodeDataError)) throw error;
      canManage = false;
    }
    const canActivate = canManage && (code.owner.kind !== "person" || code.owner.userId === viewer.id);
    const readiness: CodeVersionCardSnapshot["preview"]["readiness"] = await (async () => {
      if (row.number !== row.latest_number || code.activeVersionId === row.id || !policy) return { state: "ready" as const };
      try {
        assertCodeVersionApprovalEvidence(
          code,
          { version: row, manifest, submitted: row.submitted, withdrawn: row.withdrawn, decision: row.decision },
          policy,
          await groupsFor(code.owner.kind === "person" ? code.owner.userId : row.created_by),
        );
        return { state: "ready" as const };
      } catch (error) {
        if (!(error instanceof CodeVersionError)) throw error;
        if (error.code !== "code_approval_required") return { state: "refused" as const, code: error.code, message: error.message };
        return canManage && viewer.roles.includes("admin")
          ? pendingCodeVersionReadiness(row.approval_id, sql, context)
          : { state: "approval_pending" as const };
      }
    })();
    const origin = CodeSubmissionOriginSchema.safeParse(row.origin);
    const revision = CodeReviewRevisionSchema.safeParse(row.revision);
    const words = presentCodeVersion({
      personal: code.owner.kind === "person",
      versionId: row.id,
      number: row.number,
      submittedAt: row.created_at.toISOString(),
      manifest,
      comparison: null,
      comparisonAvailable: false,
      evidence: null,
      explanation: null,
      names,
      locale: outerContext.locale ?? "en",
      limits: { cases: 0 },
    });
    const snapshot: CodeVersionCardSnapshot = {
      preview: {
        ...ref,
        title: code.title,
        ownerKind: code.owner.kind,
        page: await pageOf(code),
        number: row.number,
        running: row.running_number,
        latest: row.latest_number,
        activated:
          code.activeVersionId === row.id && code.activatedAt
            ? { at: code.activatedAt, byYou: access.activatedById === viewer.id, byName: code.activatedBy?.name ?? null }
            : null,
        allowed: isAppSessionActor(authority.actor)
          ? { allowed: false, reason: "phone" }
          : authority.actor.kind === "user" &&
              (credentialKind === "session" || (code.owner.kind !== "person" && credentialKind === "oauth"))
            ? { allowed: true }
            : { allowed: false, reason: "credential" },
        readiness,
      },
      review: {
        status: row.withdrawn
          ? "withdrawn"
          : (row.outcome ??
            (!row.approval_id
              ? "not_required"
              : row.approval_status === "pending" && row.unexpired
                ? "pending"
                : row.approval_status === "cancelled"
                  ? "superseded"
                  : "expired")),
        origin: canManage && origin.success ? origin.data : { kind: "cli" },
        decidedBy: canManage && row.outcome ? { id: row.decided_by, name: row.name, avatarHash: row.avatar_hash } : null,
        message: canManage ? row.comment : null,
        commentCount: canManage ? row.comment_count : 0,
        revision:
          canManage && revision.success
            ? { state: revision.data.state, reason: revision.data.reason, submittedNumber: revision.data.submittedNumber }
            : null,
      },
      code: {
        state: code.state,
        activeVersionId: code.activeVersionId,
        pausedAt: code.pausedAt ?? null,
        pausedBy: access.pausedByName ? { name: access.pausedByName } : null,
      },
      facts: [...words.mayDo.items.slice(0, 2), ...words.timing.items.slice(0, 1)].map((item) => item.text),
      ...(!mayOpen
        ? { pages: { versionId: row.id, homeUrl: null, pages: [] } }
        : knownPages.has(row.id)
          ? {}
          : { pages: describeCodePages(code.id, { id: row.id, manifest }) }),
      latest: row.latest_number > row.number ? { id: row.latest_id, number: row.latest_number } : null,
      permission,
      canActivate,
      canManage,
    };
    items.push({ ...ref, state: "available", snapshot });
  }
  return codeVersionCardsContract.data.parse(fillCodeVersionCardPage(requested, items));
}
