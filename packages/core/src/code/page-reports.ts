import { sql } from "@k2b/cloud";
import { accounts, coreSettings, isAccountAllowed } from "@k2b/cloud/services";
import { listApprovalAdminRecipients } from "@k2b/cloud/services/approvals";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import { z } from "zod";
import type { CoreNotificationSender } from "../notifications";
import { type CodeContext, CodeDataError } from "./access";
import { CodeIdSchema } from "./contracts";
import { CODE_PAGE_REPORT_REASONS, type CodePageReportReason, CodePageReportReasonSchema } from "./page-provenance-contracts";
import { requireCodePolicyAdmin } from "./policy";
import { findCode } from "./store";

/**
 * Reports on Code pages (concept gustav-ui-neu 3n): members file them on a page's label, the Cloud's admins read and
 * resolve them under Administration › Code. Hosting admits the person first (`admitCodePage`); this module only
 * stores, notifies and lists. The owner of the Code is never told; an owner who is an admin sees it as an admin.
 */

/** A person files at most this many reports per hour (one open per page): every page of one automation, not spam. */
export const CODE_PAGE_REPORTS_PER_HOUR = 10;
/** The admin list's page, like the other lists of Administration › Code. */
const PAGE = 20;
/** Same page bound as the accounts directory and the review notices. */
const RECIPIENT_PAGE = 50;
/** Resolved reports go with the automation's history: runs are kept for 30 days after they end. */
const RESOLVED_RETENTION_MS = 30 * 86_400_000;

/**
 * Store one report, or answer with the report this person already has: the same key (a resend after a lost answer)
 * or an open report on the same page. The admins' notice is an outbox row in the same transaction.
 */
export async function fileCodePageReport(input: {
  codeId: string;
  path: string;
  reporterId: string;
  reason: CodePageReportReason | null;
  text: string;
  key: string;
  locale: string;
}): Promise<{ reportedAt: string }> {
  return sql.begin(async (tx) => {
    const [created] = await tx<{ id: string; created_at: Date }[]>`INSERT INTO code.page_reports
      (code_id,reporter_id,path,reason,text,locale,idempotency_key)
      VALUES(${input.codeId},${input.reporterId}::uuid,${input.path},${input.reason},${input.text},${input.locale},${input.key}::uuid)
      ON CONFLICT DO NOTHING RETURNING id,created_at`;
    if (created) {
      await tx`INSERT INTO code.page_report_outbox(report_id,kind) VALUES(${created.id}::uuid,'reported')`;
      return { reportedAt: created.created_at.toISOString() };
    }
    const [existing] = await tx<{ created_at: Date }[]>`SELECT created_at FROM code.page_reports
      WHERE reporter_id=${input.reporterId}::uuid
        AND (idempotency_key=${input.key}::uuid OR (code_id=${input.codeId} AND path=${input.path} AND state='open'))
      ORDER BY idempotency_key=${input.key}::uuid DESC LIMIT 1`;
    if (!existing) throw new Error("Code page report conflict without a stored report");
    return { reportedAt: existing.created_at.toISOString() };
  });
}

type NoticeRow = OutboxRow & { report_id: string; kind: "reported" | "resolved"; recipient_id: string | null; recipient_cursor: string };
type ReportRow = {
  code_id: string;
  path: string;
  reason: CodePageReportReason | null;
  state: "open" | "resolved";
  locale: string;
  reporter_id: string;
  reporter: string | null;
};

/** Expand one bounded page of admins after commit, or deliver one person's notice after checking them again. */
export async function deliverCodePageReportNotice(row: NoticeRow, sender: Pick<CoreNotificationSender, "sendCodePageReport">) {
  const [report] = await sql<ReportRow[]>`SELECT r.code_id,r.path,r.reason,r.state,r.locale,r.reporter_id,
      COALESCE(NULLIF(u.display_name,''),u.uid) AS reporter
    FROM code.page_reports r JOIN auth.users u ON u.id=r.reporter_id WHERE r.id=${row.report_id}::uuid`;
  if (!report) return;
  const code = await findCode(report.code_id);
  if (!code || code.state === "deleting") return;
  if (row.kind === "reported" && !row.recipient_id) {
    const ids = await listApprovalAdminRecipients(sql, { after: row.recipient_cursor, limit: RECIPIENT_PAGE });
    await sql.begin(async (tx) => {
      // The person who reported knows; an admin who reports gets no notice about their own report.
      for (const id of ids.filter((id) => id !== report.reporter_id))
        await tx`INSERT INTO code.page_report_outbox(report_id,kind,recipient_id)
          VALUES(${row.report_id}::uuid,'reported',${id}::uuid) ON CONFLICT DO NOTHING`;
      if (ids.length === RECIPIENT_PAGE)
        await tx`INSERT INTO code.page_report_outbox(report_id,kind,recipient_cursor)
          VALUES(${row.report_id}::uuid,'reported',${ids.at(-1)!}::uuid) ON CONFLICT DO NOTHING`;
    });
    return;
  }
  const recipientId = row.kind === "resolved" ? report.reporter_id : row.recipient_id;
  if (!recipientId) return;
  const user = await accounts.users.get({ id: recipientId });
  if (!user || (user.accountExpires && Date.parse(user.accountExpires) <= Date.now()) || !(await isAccountAllowed(user))) return;
  if (row.kind === "reported") {
    // Resolved before this admin was told, or no longer an admin: nothing to do.
    if (report.state !== "open" || !(await listApprovalAdminRecipients(sql, { userId: user.id })).length) return;
  } else if (report.state !== "resolved") throw new Error("Resolved report notice has no resolved report");
  const [preference] = await sql<
    { locale: string | null }[]
  >`SELECT notification_locale AS locale FROM auth.users WHERE id=${user.id}::uuid`;
  const locale = preference?.locale ?? (user.id === report.reporter_id ? report.locale : await coreSettings.get<string>("app.locale"));
  const base = {
    userId: user.id,
    locale,
    key: `code-page-report:${row.report_id}:${row.kind}:${user.id}`,
    codeId: code.id,
    path: report.path,
  };
  await sender.sendCodePageReport(
    row.kind === "reported"
      ? { ...base, kind: "reported", title: code.title, reason: report.reason, by: report.reporter }
      : { ...base, kind: "resolved" },
  );
}

export const createCodePageReportNotificationOutbox = (sender: Pick<CoreNotificationSender, "sendCodePageReport">) =>
  createPgOutbox<NoticeRow>({
    table: "code.page_report_outbox",
    name: "core:code-page-report-notifications",
    orderBy: "report_id",
    sequence: "sequence",
    batchSize: 1,
    reconcileIntervalMs: 5000,
    publish: (row) => deliverCodePageReportNotice(row, sender),
  });

export const codePageReportContracts = {
  list: {
    input: z
      .object({
        codeId: CodeIdSchema,
        state: z.enum(["open", "resolved"]).default("open"),
        /** Opaque cursor of the previous page. */
        cursor: z.string().max(100).optional(),
      })
      .strict(),
  },
  resolve: { input: z.object({ codeId: CodeIdSchema, reportId: z.uuid() }).strict() },
} as const;

export const CodePageReportSchema = z
  .object({
    id: z.uuid(),
    reporter: z.object({ id: z.uuid(), name: z.string() }).strict(),
    path: z.string(),
    reason: z.enum(CODE_PAGE_REPORT_REASONS).nullable(),
    text: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    state: z.enum(["open", "resolved"]),
    resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type CodePageReport = z.infer<typeof CodePageReportSchema>;
export const CodePageReportPageSchema = z.object({ items: z.array(CodePageReportSchema), nextCursor: z.string().nullable() }).strict();
export type CodePageReportPage = z.infer<typeof CodePageReportPageSchema>;

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/;

/** One page of an automation's reports for Cloud admins, newest first. Who resolved one is not shown. */
export async function listCodePageReports(
  input: z.input<typeof codePageReportContracts.list.input>,
  context: CodeContext,
): Promise<CodePageReportPage> {
  requireCodePolicyAdmin(context);
  const { codeId, state, cursor } = codePageReportContracts.list.input.parse(input);
  const after = cursor ? CURSOR.exec(cursor) : null;
  if (cursor && !after) throw new CodeDataError("BAD_INPUT", "Invalid report cursor.");
  const rows = await sql<
    {
      id: string;
      reporter_id: string;
      reporter: string;
      path: string;
      reason: CodePageReportReason | null;
      text: string;
      created_at: Date;
      cursor_time: string;
      state: "open" | "resolved";
      resolved_at: Date | null;
    }[]
  >`SELECT r.id,r.reporter_id,COALESCE(NULLIF(u.display_name,''),u.uid) AS reporter,r.path,r.reason,r.text,r.created_at,
      to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,r.state,r.resolved_at
    FROM code.page_reports r JOIN auth.users u ON u.id=r.reporter_id
    WHERE r.code_id=${codeId} AND r.state=${state}
      AND (${after?.[1] ?? null}::timestamptz IS NULL OR (r.created_at,r.id) < (${after?.[1] ?? null}::timestamptz,${after?.[2] ?? null}::uuid))
    ORDER BY r.created_at DESC,r.id DESC LIMIT ${PAGE + 1}`;
  const last = rows.length > PAGE ? rows[PAGE - 1] : undefined;
  return {
    items: rows.slice(0, PAGE).map((row) => ({
      id: row.id,
      reporter: { id: row.reporter_id, name: row.reporter },
      path: row.path,
      reason: CodePageReportReasonSchema.nullable().parse(row.reason),
      text: row.text,
      createdAt: row.created_at.toISOString(),
      state: row.state,
      resolvedAt: row.resolved_at?.toISOString() ?? null,
    })),
    nextCursor: last ? `${last.cursor_time}|${last.id}` : null,
  };
}

/** Mark one report resolved and tell the person who filed it, after commit. Resolving twice changes nothing. */
export async function resolveCodePageReport(
  input: z.input<typeof codePageReportContracts.resolve.input>,
  context: CodeContext,
): Promise<{ state: "resolved"; resolvedAt: string }> {
  const admin = requireCodePolicyAdmin(context, true);
  const { codeId, reportId } = codePageReportContracts.resolve.input.parse(input);
  return sql.begin(async (tx) => {
    const [resolved] = await tx<{ resolved_at: Date }[]>`UPDATE code.page_reports
      SET state='resolved',resolved_by=${admin.id}::uuid,resolved_at=now()
      WHERE id=${reportId}::uuid AND code_id=${codeId} AND state='open' RETURNING resolved_at`;
    if (resolved) {
      await tx`INSERT INTO code.page_report_outbox(report_id,kind) VALUES(${reportId}::uuid,'resolved') ON CONFLICT DO NOTHING`;
      return { state: "resolved" as const, resolvedAt: resolved.resolved_at.toISOString() };
    }
    const [current] = await tx<{ resolved_at: Date | null }[]>`SELECT resolved_at FROM code.page_reports
      WHERE id=${reportId}::uuid AND code_id=${codeId}`;
    if (!current?.resolved_at) throw new CodeDataError("NOT_FOUND", "Report not found.");
    return { state: "resolved" as const, resolvedAt: current.resolved_at.toISOString() };
  });
}

/** One bounded batch: resolved reports leave with the automation's run history, 30 days after they were resolved. */
export const expireCodePageReports = async (options: { now: Date; limit: number }): Promise<number> => {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)
    throw new RangeError("Invalid Code page report retention batch size");
  const cutoff = new Date(options.now.getTime() - RESOLVED_RETENTION_MS);
  const result = await sql`DELETE FROM code.page_reports WHERE id IN (SELECT id FROM code.page_reports
    WHERE state='resolved' AND resolved_at <= ${cutoff} ORDER BY resolved_at,id LIMIT ${options.limit} FOR UPDATE SKIP LOCKED)`;
  return result.count;
};
