import { sql } from "@k2b/cloud";
import type { AiOpenQuestion, AiOpenQuestions } from "@k2b/cloud/ai";
import { buildAccessPrincipalCondition } from "@k2b/cloud/server";
import { CodeDataError } from "./access";
import { codeChatMissingCondition, codeChatSchemaAvailable } from "./chat-binding";
import { requireCodeEventAccess } from "./event-access";
import { type CodeManagerCandidate, currentChatManagers } from "./manager-recipients";
import { CodeSubmissionOriginSchema, codeVersionChatAnchor } from "./review-contracts";
import { findCode } from "./store";

/** One domain source for the shared waiting list. The same read supplies badges, page and notification targets. */
export async function listCodeWaiting(
  input: { ownerUserId: string; locale: string; timeZone: string; versionId?: string },
  signal: AbortSignal,
): Promise<AiOpenQuestions> {
  const items: AiOpenQuestion[] = [];
  let count = 0,
    after = "00000000-0000-0000-0000-000000000000";
  // Keyset pages bound each read and provider batch; the invoking capability's deadline bounds the whole snapshot.
  for (;;) {
    signal.throwIfAborted();
    const rows = await sql<
      (CodeManagerCandidate & {
        origin: unknown;
        locale: string;
        number: number;
        title: string;
        outcome: string | null;
        chat_id: string;
        chat_title: string | null;
        created_at: Date;
        approval_id: string | null;
        expired: boolean;
        state: string | null;
        failure_code: string | null;
      })[]
    >`SELECT
      s.version_id,s.code_id,(s.origin->>'conversationId')::uuid AS conversation_id,v.created_by AS user_id,v.number,c.title,
      c.owner_kind,c.owner_user_id,c.owner_app_id,c.owner_type,c.owner_id,s.origin,s.locale,s.approval_id,
      chat.short_id AS chat_id,chat.title AS chat_title,s.created_at,d.outcome,w.state,
      (r.expires_at<=now() OR r.status='expired') AS expired,
      (SELECT a.failure->>'code' FROM code.activations a WHERE a.code_id=c.id AND a.version_id=v.id
        ORDER BY a.created_at DESC LIMIT 1) AS failure_code
      FROM code.version_submissions s JOIN code.versions v ON v.id=s.version_id JOIN code.codes c ON c.id=s.code_id
        JOIN ai.conversations chat ON chat.id=(s.origin->>'conversationId')::uuid AND chat.created_by_user_id=v.created_by
        LEFT JOIN code.version_decisions d ON d.version_id=v.id LEFT JOIN approvals.requests r ON r.id=s.approval_id
        LEFT JOIN code.review_chat_work w ON w.version_id=v.id
      WHERE s.origin->>'kind'='ai_chat' AND v.created_by=${input.ownerUserId}::uuid AND c.state<>'deleting'
        AND v.id IS DISTINCT FROM c.active_version_id AND NOT EXISTS(SELECT 1 FROM code.versions newer WHERE newer.code_id=c.id AND newer.number>v.number)
        AND NOT EXISTS(SELECT 1 FROM code.version_withdrawals withdrawn WHERE withdrawn.version_id=v.id)
        AND (d.outcome='approved' OR (s.approval_id IS NULL AND d.outcome IS NULL) OR (d.outcome='changes_requested' AND COALESCE(w.state,'none') NOT IN ('queued','running'))
          OR (d.outcome IS NULL AND (r.expires_at<=now() OR r.status='expired')))
        AND (${input.versionId ?? null}::uuid IS NULL OR s.version_id=${input.versionId ?? null}::uuid)
        AND s.version_id>${after}::uuid ORDER BY s.version_id LIMIT 50`;
    if (!rows.length) break;
    const allowed = await currentChatManagers(rows, signal);
    for (const row of rows) {
      if (!allowed.has(row.version_id)) continue;
      const de = input.locale.startsWith("de");
      const kind = row.expired && !row.outcome ? "code_expired" : row.outcome === "changes_requested" ? "code_changes" : "code_activate";
      const short =
        kind === "code_expired"
          ? de
            ? `Freigabe abgelaufen: ${row.title}`
            : `Approval expired: ${row.title}`
          : kind === "code_changes"
            ? de
              ? `Änderungen an Version ${row.number} ansehen`
              : `View changes to version ${row.number}`
            : de
              ? `Version ${row.number} einschalten`
              : `Switch on version ${row.number}`;
      const origin = CodeSubmissionOriginSchema.parse(row.origin);
      count++;
      items.push({
        id: `code:${row.version_id}`,
        kind,
        conversationId: row.chat_id,
        conversationTitle: row.chat_title,
        anchor: codeVersionChatAnchor(row.version_id, origin),
        short: [...short].slice(0, 160).join(""),
        app: { name: "Code", icon: kind === "code_activate" ? "ti ti-player-play" : "ti ti-code" },
        createdAt: row.created_at.toISOString(),
      });
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      items.splice(20);
    }
    after = rows.at(-1)!.version_id;
    if (rows.length < 50) break;
  }
  const attention = input.versionId ? { count: 0, items: [] } : await listCodeAttentionWaiting(input, signal);
  return {
    count: count + attention.count,
    items: [...items, ...attention.items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, 20),
  };
}

/** Operational problems are actionable on the Code page, including Code created outside a chat. */
async function listCodeAttentionWaiting(input: { ownerUserId: string; locale: string }, signal: AbortSignal): Promise<AiOpenQuestions> {
  const items: AiOpenQuestion[] = [];
  let count = 0,
    after = "";
  const missingChat = codeChatMissingCondition(await codeChatSchemaAvailable());
  const principal = buildAccessPrincipalCondition({
    subject: { type: "user", userId: input.ownerUserId },
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  for (;;) {
    signal.throwIfAborted();
    const rows = await sql<
      (CodeManagerCandidate & {
        title: string;
        created_at: Date;
        failure_code: string | null;
        reason: "secret" | "mandate" | "access" | "chat_missing";
      })[]
    >`WITH candidates AS (
      SELECT c.*, COALESCE(c.active_version_id,a.version_id) AS version_id,a.state AS activation_state,a.failure,
        a.updated_at AS activation_at,a.mandate_id
      FROM code.codes c LEFT JOIN LATERAL (SELECT * FROM code.activations WHERE code_id=c.id ORDER BY created_at DESC,id DESC LIMIT 1) a ON true
      WHERE c.state<>'deleting' AND c.id>${after}
        AND (c.active_version_id IS NOT NULL OR a.state='failed' OR ${missingChat})
        AND (c.owner_user_id=${input.ownerUserId}::uuid OR c.created_by=${input.ownerUserId}::uuid OR a.activating_person=${input.ownerUserId}::uuid
          OR EXISTS(SELECT 1 FROM code.versions own_version JOIN code.version_submissions own_submission ON own_submission.version_id=own_version.id
            WHERE own_version.code_id=c.id AND own_version.created_by=${input.ownerUserId}::uuid)
          OR EXISTS(SELECT 1 FROM code.shares j JOIN auth.access a ON a.id=j.access_id WHERE j.code_id=c.id AND a.permission IN ('write','admin') AND ${principal})
          OR (c.owner_kind='app' AND EXISTS(SELECT 1 FROM auth.app_access j JOIN auth.access a ON a.id=j.access_id
            WHERE j.app_id=c.owner_app_id AND a.permission='admin' AND ${principal})))
    ), problems AS (
      SELECT c.id AS code_id,c.version_id,${input.ownerUserId}::uuid AS user_id,c.owner_kind,c.owner_user_id,c.owner_app_id,c.owner_type,c.owner_id,c.title,
        COALESCE(c.activation_at,c.created_at) AS created_at,c.failure->>'code' AS failure_code,
        CASE
          WHEN ${missingChat} AND c.owner_user_id=${input.ownerUserId}::uuid THEN 'chat_missing'
          WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(v.manifest->'secrets','[]'::jsonb)) b
            WHERE NOT EXISTS(SELECT 1 FROM code.secrets s WHERE s.code_id=c.id AND s.name=b->>'name'
              AND s.binding_revision=(b->>'binding_revision')::uuid AND s.encrypted IS NOT NULL)) THEN 'secret'
          WHEN c.active_version_id IS NOT NULL AND (m.id IS NULL OR m.state<>'active' OR m.confirmed_at IS NULL OR m.expires_at<=now()) THEN 'mandate'
          WHEN c.activation_state='failed' AND c.failure->>'code' IN ('FORBIDDEN','authority_changed','authority_revoked','not_owner_manager') THEN 'access'
        END AS reason
      FROM candidates c LEFT JOIN code.versions v ON v.id=c.version_id LEFT JOIN LATERAL
        (SELECT id,state,expires_at,confirmed_at FROM auth.mandates WHERE owner_app_id IN ('core','runner') AND workload_type='code.version'
          AND workload_id=c.active_version_id::text ORDER BY created_at DESC,id DESC LIMIT 1) m ON true
    ) SELECT * FROM problems WHERE reason IS NOT NULL ORDER BY code_id LIMIT 50`;
    if (!rows.length) break;
    // An unavailable owner cannot break unrelated Assistant surfaces. Direct grants remain usable;
    // a failed remote owner check contributes no actionable item in this snapshot.
    const allowed = await currentChatManagers(
      rows.filter((row) => row.reason !== "chat_missing"),
      signal,
    );
    for (const row of rows) {
      if (row.reason === "chat_missing" ? row.owner_user_id !== input.ownerUserId : !allowed.has(row.version_id)) continue;
      // A past refusal is only a candidate. A repaired event-place grant removes the item immediately.
      if (row.reason === "access" && row.failure_code === "FORBIDDEN") {
        const code = await findCode(row.code_id);
        if (!code) continue;
        try {
          await requireCodeEventAccess(code, row.version_id, signal);
          continue;
        } catch (error) {
          signal.throwIfAborted();
          // An unavailable event app is not evidence of missing access and must not
          // take down the person's other waiting entries.
          if (!(error instanceof CodeDataError) || !["FORBIDDEN", "BAD_INPUT"].includes(error.code)) continue;
        }
      }
      const de = input.locale.startsWith("de");
      const short = de
        ? `${row.title} ${row.reason === "chat_missing" ? "braucht einen Chat" : row.reason === "secret" ? "braucht ein Secret" : row.reason === "mandate" ? "braucht deine Bestätigung" : "braucht Zugriff"}`
        : `${row.title} ${row.reason === "chat_missing" ? "needs a chat" : row.reason === "secret" ? "needs a secret" : row.reason === "mandate" ? "needs your confirmation" : "needs access"}`;
      count++;
      items.push({
        id: `code-attention:${row.code_id}`,
        kind: "code_attention",
        conversationId: "",
        conversationTitle: null,
        anchor: "",
        short: [...short].slice(0, 160).join(""),
        app: { name: "Code", icon: "ti ti-code" },
        createdAt: row.created_at.toISOString(),
        href: `/app/assistant/code/${row.code_id}${row.reason === "secret" ? "?tab=secrets" : ""}`,
      });
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      items.splice(20);
    }
    after = rows.at(-1)!.code_id;
    if (rows.length < 50) break;
  }
  return { count, items };
}
