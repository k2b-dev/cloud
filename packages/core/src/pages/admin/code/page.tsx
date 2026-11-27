import { type AuthContext, auth, getDateConfig, getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { formatDateTime, isAdminUser } from "@k2b/cloud/shared";
import { AdminLayout, getLocalizedRuntimeContext } from "@k2b/cloud/ssr";
import { declaredIconColor } from "@k2b/cloud/ssr/app-icon-style";
import { type CodeContext, CodeDataError } from "../../../code/access";
import { ssr } from "../../../config";
import { recentChanges } from "../_area/RecentChanges";
import { settingsDocumentationHref } from "../settings/documentation";
import { codeAreaSection, parseCodeAreaQuery } from "./area";
import { type CodeApp, type CodeAreaData, ok } from "./data";
import { loadCodeArea } from "./load";
import { codeAdminMessages } from "./messages";
import { codeNav } from "./nav";
import CodeScreen from "./screen";

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
      data = await loadCodeArea({ query, context, locale, counts: c.get("adminCodeCounts") });
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
