import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { MinimalLayout, requestPath } from "@k2b/cloud/ssr";
import { ButtonLink, NoticeCard } from "@k2b/ui";
import { ssr } from "../config";
import { pulseMessages } from "../messages";
import { readPublicDashboard } from "../service/dashboard-panels";
import PublicDashboard from "./PublicDashboard.island";
import { readDashboardRange } from "./workspace/dashboard-data";

export default ssr<AuthContext>(async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  const token = c.req.param("token") ?? "";
  const result = await readPublicDashboard(token).catch(() => null);
  const t = pulseMessages.resolve([getLocale(c)]).t;
  const path = requestPath(c);
  const range = readDashboardRange(path);
  const denied = result && !result.ok && [401, 403, 404].includes(result.error.status);
  c.get("page").title = result?.ok ? result.data.name : denied ? t.dashboardDenied : t.pulseDataRefreshFailed;
  if (!result) c.status(503);
  else if (!result.ok) c.status(result.error.status);
  return () => (
    <MinimalLayout c={c}>
      {result?.ok ? (
        <PublicDashboard dashboard={result.data} token={token} range={range} path={path} />
      ) : (
        <main class="mx-auto w-full max-w-2xl px-4 py-10">
          <NoticeCard
            tone="warning"
            title={denied ? t.dashboardDenied : t.pulseDataRefreshFailed}
            detail={denied ? t.dashboardDeniedDetail : t.dashboardUnavailableDetail}
          >
            <ButtonLink href={path} variant="secondary">
              {t.retry}
            </ButtonLink>
          </NoticeCard>
        </main>
      )}
    </MinimalLayout>
  );
});
