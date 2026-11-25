import { type AuthContext, getLocale, REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { pulseMessages } from "../../messages";
import SourcesScreen from "../screens/SourcesScreen.island";
import SqlScreen from "../screens/SqlScreen.island";
import { PULSE_SETTINGS_TABS } from "../workspace/routes";
import { loadPulseWorkspacePageData } from "./page-data";

/** Where an old `?settings=<tab>` link of a base view leads: the settings page and that tab. */
export const settingsRedirect = (baseId: string, value: string | null): string | null => {
  if (value === null) return null;
  const tab = PULSE_SETTINGS_TABS.find((entry) => entry === value) ?? "general";
  return `/app/pulse/${encodeURIComponent(baseId)}/settings${tab === "general" ? "" : `/${tab}`}`;
};

/** Sources and SQL of a base on v2. The server reads everything the first picture shows. */
export default ssr<AuthContext>(async (c) => {
  const moved = settingsRedirect(c.req.param("baseId") ?? "", c.req.query("settings") ?? null);
  if (moved) return c.redirect(moved);
  setRequestTimeout(c, 60);
  let data: Awaited<ReturnType<typeof loadPulseWorkspacePageData>>;
  try {
    data = await loadPulseWorkspacePageData(c);
  } finally {
    setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
  }
  const { t } = pulseMessages.resolve([getLocale(c)]);
  if (data.kind === "error") return ssr.error(c, data.status, { action: { label: t.backToPulse, href: "/app/pulse" } });

  const props = data.workspaceProps;
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.appName, href: "/app/pulse" },
        { title: data.baseName, href: `/app/pulse/${props.initialBaseId}` },
      ]}
    >
      {props.initialRouteState.view === "sql" ? (
        <SqlScreen
          bases={props.initialBases}
          baseId={props.initialBaseId}
          sourceCount={props.initialSources.length}
          route={props.initialRouteState}
          snapshot={props.initialSql}
          canWrite={props.initialPermissions?.write ?? false}
        />
      ) : (
        <SourcesScreen {...props} initialSearch={c.req.query("q")?.trim() ?? ""} />
      )}
    </Layout>
  );
});
