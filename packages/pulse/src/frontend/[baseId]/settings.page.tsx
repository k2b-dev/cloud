import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { pulseMessages } from "../../messages";
import SettingsScreen from "../screens/SettingsScreen.island";
import { PULSE_SETTINGS_TABS } from "../workspace/routes";
import { loadPulseSettingsPageData } from "./page-data";

/** A base's settings as a page: `/settings` is the general tab, `/settings/<tab>` the others. */
export default ssr<AuthContext>(async (c) => {
  const requested = c.req.param("tab");
  const tab = PULSE_SETTINGS_TABS.find((entry) => entry === requested);
  const baseId = encodeURIComponent(c.req.param("baseId") ?? "");
  if (requested !== undefined && (!tab || tab === "general")) return c.redirect(`/app/pulse/${baseId}/settings`);
  const data = await loadPulseSettingsPageData(c, tab ?? "general");
  const { t } = pulseMessages.resolve([getLocale(c)]);
  if (data.kind === "error") return ssr.error(c, data.status, { action: { label: t.backToPulse, href: "/app/pulse" } });
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.appName, href: "/app/pulse" },
        { title: data.base.name, href: `/app/pulse/${data.publicBaseId}` },
        { title: t.settings },
      ]}
    >
      <SettingsScreen
        bases={data.bases}
        base={data.base}
        tab={tab ?? "general"}
        canAdmin={data.canAdmin}
        admins={data.admins}
        maxRawRetentionDays={data.maxRawRetentionDays}
        access={data.access}
        limits={data.limits}
      />
    </Layout>
  );
});
