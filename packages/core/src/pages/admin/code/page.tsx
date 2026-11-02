import { type AuthContext, auth, getDateConfig, getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { isAdminUser } from "@k2b/cloud/shared";
import { AdminLayout, getLocalizedRuntimeContext, requestPath } from "@k2b/cloud/ssr";
import { type CodeContext, CodeDataError } from "../../../code/access";
import {
  listCodeAdminApprovals,
  listCodeAdminCleanup,
  listCodeAdminCodes,
  listCodeAdminDecided,
  readCodeAdminApproval,
  readCodeAdminCode,
  readCodeAdminEffective,
  readCodeAdminPolicy,
  readCodeAdminPolicyHistory,
  readCodeAdminRunners,
  readCodeAdminSummary,
  readCodeAdminVersionSource,
} from "../../../code/admin";
import { CODE_SETTINGS } from "../../../code/settings";
import { ssr } from "../../../config";
import { buildEntries } from "../settings/entries";
import { CODE_LIMIT_KEYS, parseCodeAreaQuery } from "./area";
import { codeAdminMessages } from "./messages";
import { type CodeAreaData, CodeAreaView } from "./view";

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

  let data: CodeAreaData | null = null;
  let noPermission = !allowed;
  if (allowed) {
    try {
      const summary = await attempt(() => readCodeAdminSummary(context));
      const sec = query.sec;
      const limitKeys = [
        ...CODE_LIMIT_KEYS,
        ...Object.keys(CODE_SETTINGS).filter((key) => !CODE_LIMIT_KEYS.some((limit) => limit === key)),
      ];
      data = {
        summary,
        approvals:
          sec === "approvals"
            ? await attempt(() =>
                query.tab === "decided"
                  ? Promise.resolve({ items: [], nextCursor: null })
                  : listCodeAdminApprovals(context, { cursor: query.after }),
              )
            : null,
        decided: sec === "approvals" && query.tab === "decided" ? await attempt(() => listCodeAdminDecided(context)) : null,
        approval: sec === "approvals" && query.id ? await attempt(() => readCodeAdminApproval(query.id ?? "", context)) : null,
        codes:
          sec === "code"
            ? await attempt(() => listCodeAdminCodes({ status: query.status, app: query.app, q: query.q, cursor: query.after }, context))
            : null,
        code: sec === "code" && query.id ? await attempt(() => readCodeAdminCode(query.id ?? "", context)) : null,
        source:
          sec === "code" && query.id && query.version
            ? await attempt(() => readCodeAdminVersionSource(query.id ?? "", query.version ?? "", context))
            : null,
        policy: sec === "policy" || sec === "groups" || sec === "effective" ? await attempt(() => readCodeAdminPolicy(context)) : null,
        effective: sec === "effective" && query.id ? await attempt(() => readCodeAdminEffective(query.id ?? "", context)) : null,
        history: sec === "history" ? await attempt(() => readCodeAdminPolicyHistory(context)) : null,
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

  return () => (
    <AdminLayout c={c} title={t.area} ownMain>
      <CodeAreaView
        t={t}
        locale={locale}
        dateConfig={getDateConfig(c)}
        query={query}
        data={data}
        noPermission={noPermission}
        retryHref={requestPath(c)}
        appNames={Object.fromEntries(runtime.apps.map((app) => [app.id, app.name]))}
        documentationBase={documentationBase}
      />
    </AdminLayout>
  );
});
