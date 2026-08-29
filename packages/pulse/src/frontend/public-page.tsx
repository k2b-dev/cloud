import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { ssr } from "../config";
import { pulseService } from "../service";
import { projectDashboardSnapshot } from "../service/public-resources";
import PublicPulseDashboard from "./PublicPulseDashboard.island";
import { parsePublicDashboardDisplayHeight, parsePublicDashboardTheme } from "./public-dashboard-runtime";
import { pulseMessages } from "../messages";

export default ssr<AuthContext>(async (c) => {
  c.header("Referrer-Policy", "no-referrer");
  const token = c.req.param("token") ?? "";
  const theme = parsePublicDashboardTheme(c.req.query("theme"));
  const displayHeight = parsePublicDashboardDisplayHeight(c.req.query("height"));
  c.get("page").theme = theme;
  const snapshot = await pulseService.dashboard.publicSnapshot(token);
  const { t } = pulseMessages.resolve([getLocale(c)]);
  if (!snapshot.ok) {
    return () => (
      <main class="flex min-h-screen items-center justify-center bg-zinc-50 p-6 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
        <section class="paper max-w-md p-6 text-center">
          <h1 class="text-xl font-semibold">{t.dashboardNotFound}</h1>
          <p class="mt-2 text-sm text-dimmed">{snapshot.error.message}</p>
        </section>
      </main>
    );
  }

  const dateConfig = getDateConfig(c);
  const publicSnapshot = await projectDashboardSnapshot(snapshot.data);

  return () => (
    <PublicPulseDashboard token={token} initialSnapshot={publicSnapshot} initialDateConfig={dateConfig} displayHeight={displayHeight} />
  );
});
