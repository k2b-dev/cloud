import type { CodeAdminCounts } from "@k2b/cloud/ssr/code-admin-counts";
import { type CodeContext, CodeDataError } from "../../../code/access";
import {
  type CodeAdminApprovalDetail,
  listCodeAdminApprovals,
  listCodeAdminCleanup,
  listCodeAdminCodes,
  listCodeAdminDecided,
  readCodeAdminApproval,
  readCodeAdminCode,
  readCodeAdminEffective,
  readCodeAdminPolicy,
  readCodeAdminPolicyHistoryPage,
  readCodeAdminRunners,
  readCodeAdminSummary,
} from "../../../code/admin";
import { listUnusedCodeDatabases } from "../../../code/database-retention";
import { listCodePageReports } from "../../../code/page-reports";
import { CODE_SETTINGS } from "../../../code/settings";
import { buildEntries } from "../settings/entries";
import { CODE_LIMIT_KEYS, type CodeAreaQuery, codeAreaSection } from "./area";
import { type CodeAreaData, ok } from "./data";

/** Load a part; a failure becomes that part's error state instead of failing the page. */
const attempt = async <T>(load: () => Promise<T>): Promise<T | "failed" | "missing"> => {
  try {
    return await load();
  } catch (error) {
    if (error instanceof CodeDataError && error.code === "NOT_FOUND") return "missing";
    if (error instanceof CodeDataError && error.code === "FORBIDDEN") throw error;
    console.error("[admin/code] load failed", error);
    return "failed";
  }
};

/**
 * The one server load of Administration › Code for the address's section: the area's counts and the parts the open
 * section shows, nothing else. A missing Code policy admin authority throws `CodeDataError("FORBIDDEN")`.
 */
export async function loadCodeArea(input: {
  query: CodeAreaQuery;
  context: CodeContext;
  locale: string;
  /** The admin counts the request already read for the admin bar. */
  counts?: CodeAdminCounts;
}): Promise<CodeAreaData> {
  const { query, context, locale } = input;
  const sec = codeAreaSection(query);
  const summary = await attempt(() => readCodeAdminSummary(context, input.counts));
  const limitKeys = [...CODE_LIMIT_KEYS, ...Object.keys(CODE_SETTINGS).filter((key) => !CODE_LIMIT_KEYS.some((limit) => limit === key))];
  const approval: CodeAreaData["approval"] =
    sec === "approvals" && query.id ? await attempt(() => readCodeAdminApproval(query.id ?? "", context)) : null;
  // An open review stands beside its own list: a decided one beside the decided versions, a waiting one beside the
  // waiting ones. The list is read once either way.
  const decidedList = query.tab === "decided" || (ok<CodeAdminApprovalDetail>(approval) && approval.status !== "pending");
  return {
    summary,
    approvals: sec === "approvals" && !decidedList ? await attempt(() => listCodeAdminApprovals(context, { cursor: query.after })) : null,
    decided: sec === "approvals" && decidedList ? await attempt(() => listCodeAdminDecided(context)) : null,
    approval,
    codes:
      sec === "code"
        ? await attempt(() => listCodeAdminCodes({ status: query.status, app: query.app, q: query.q, cursor: query.after }, context))
        : null,
    code: sec === "code" && query.id ? await attempt(() => readCodeAdminCode(query.id ?? "", context)) : null,
    reports: sec === "code" && query.id ? await attempt(() => listCodePageReports({ codeId: query.id ?? "" }, context)) : null,
    policy: sec === "policy" || sec === "groups" ? await attempt(() => readCodeAdminPolicy(context)) : null,
    effective: sec === "effective" && query.id ? await attempt(() => readCodeAdminEffective(query.id ?? "", context)) : null,
    history: sec === "history" ? await attempt(() => readCodeAdminPolicyHistoryPage(context, { page: Number(query.after ?? 1) })) : null,
    databases: sec === "databases" ? await attempt(() => listUnusedCodeDatabases(context, query.after)) : null,
    cleanup: sec === "cleanup" ? await attempt(() => listCodeAdminCleanup(context, { cursor: query.after })) : null,
    runners: sec === "runners" ? await attempt(() => readCodeAdminRunners(context)) : null,
    limits:
      sec === "limits"
        ? await attempt(async () => {
            const entries = await buildEntries("core", locale);
            return limitKeys.flatMap((key) => entries.filter((entry) => entry.key === key));
          })
        : null,
  };
}
