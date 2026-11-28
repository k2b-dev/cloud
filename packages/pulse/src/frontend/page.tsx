import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { pulseMessages } from "../messages";
import StartScreen from "./screens/StartScreen.island";
import { loadPulseStart } from "./start-data";

/**
 * Pulse has no list of bases: the sidebar's switcher and search reach every base. `/app/pulse` (old `?q=` links too)
 * opens the base worked in last, else the newest; only before the first base it shows the start.
 */
export default ssr<AuthContext>(async (c) => {
  const start = await loadPulseStart(c);
  if (start.kind === "open") return c.redirect(start.href, 302);
  const { t } = pulseMessages.resolve([getLocale(c)]);
  return () => (
    <Layout c={c} fullWidth ui="v2" title={[{ title: t.start, href: "/" }, { title: t.appName }]}>
      <StartScreen deleting={start.deleting} />
    </Layout>
  );
});
