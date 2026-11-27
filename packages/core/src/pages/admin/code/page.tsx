import { type AuthContext, auth, getDateConfig, getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { formatDateTime, isAdminUser } from "@k2b/cloud/shared";
import { AdminLayout, getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { declaredIconColor } from "@k2b/cloud/ssr/app-icon-style";
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
import { ssr } from "../../../config";
import { recentChanges } from "../_area/RecentChanges";
import { settingsDocumentationHref } from "../settings/documentation";
import { buildEntries } from "../settings/entries";
import { CODE_LIMIT_KEYS, codeAreaSection, parseCodeAreaQuery } from "./area";
import { type CodeApp, type CodeAreaData, ok } from "./data";
import { codeAdminMessages } from "./messages";
import { codeNav } from "./nav";
import CodeScreen from "./screen";

/** Load a part; a failure becomes that part's error state instead of failing the page. */
const attempt = async <T,>(load: () => Promise<T>): Promise<T | "failed" | "missing"> => {
  try {
    return await load();
  } catch (error) {
    if (error instanceof CodeDataError && error.code === "NOT_FOUND") return "missing";
    if (error instanceof CodeDataError && error.code === "FORBIDDEN") throw error;
    console.error("[admin/code] load failed", error);
    return "failed";
  }
};

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const t = codeAdminMessages.resolve([locale]).t;
  const query = parseCodeAreaQuery(c.req.query());
  const runtime = getLocalizedRuntimeContext(c);
  const context: CodeContext = { authority: auth.getAuthority(c), locale, signal: c.req.raw.signal };
  const allowed = isAdminUser(c.get("user"));
  const sec = codeAreaSection(query);
  const dateConfig = getDateConfig(c);

  let data: CodeAreaData | null = null;
  let noPermission = !allowed;
  if (allowed) {
    try {
      const summary = await attempt(() => readCodeAdminSummary(context, c.get("adminCodeCounts")));
      const limitKeys = [
        ...CODE_LIMIT_KEYS,
        ...Object.keys(CODE_SETTINGS).filter((key) => !CODE_LIMIT_KEYS.some((limit) => limit === key)),
      ];
      const approval: CodeAreaData["approval"] =
        sec === "approvals" && query.id ? await attempt(() => readCodeAdminApproval(query.id ?? "", context)) : null;
      // An open review stands beside its own list: a decided one beside the decided versions, a waiting one beside the
      // waiting ones. The list is read once either way.
      const decidedList = query.tab === "decided" || (ok<CodeAdminApprovalDetail>(approval) && approval.status !== "pending");
      data = {
        summary,
        approvals:
          sec === "approvals" && !decidedList ? await attempt(() => listCodeAdminApprovals(context, { cursor: query.after })) : null,
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
        history:
          sec === "history" ? await attempt(() => readCodeAdminPolicyHistoryPage(context, { page: Number(query.after ?? 1) })) : null,
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
    } catch (error) {
      if (!(error instanceof CodeDataError && error.code === "FORBIDDEN")) throw error;
      noPermission = true;
    }
  }
  const documentationBase = await coreSettings.get<string>("app.documentation_url").catch(() => undefined);
  const apps: Record<string, CodeApp> = Object.fromEntries(
    runtime.apps.map((app) => [
      app.id,
      { name: app.name, ...(declaredIconColor(app.appearance) ? { color: declaredIconColor(app.appearance) } : {}) },
    ]),
  );
  const limits = data && ok(data.limits) ? data.limits : null;

  return () => (
    <AdminLayout c={c} ui="v2" title={t.sectionLabel({ s: sec })}>
      <CodeScreen
        nav={codeNav(c, locale, sec, data && ok(data.summary) ? data.summary : null)}
        query={query}
        locale={locale}
        dateConfig={dateConfig}
        viewerId={c.get("user")?.id ?? ""}
        apps={apps}
        documentationHref={sec === "limits" ? settingsDocumentationHref(documentationBase, "code-limits") : undefined}
        data={data}
        noPermission={noPermission}
        recent={limits ? recentChanges(limits, locale, (iso) => formatDateTime(iso, dateConfig)) : undefined}
      />
    </AdminLayout>
  );
});
