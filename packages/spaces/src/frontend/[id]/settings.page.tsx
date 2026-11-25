import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { ResourceShortIdSchema } from "../../contracts";
import { spacesPageHelp } from "../../help";
import { loadSpacesSidebar } from "../../service/overview";
import { spacesPublicResources } from "../../service/public-resources";
import { SETTINGS_TABS, visibleTabs } from "./_components/edit/SettingsScreen";
import SettingsScreen from "./_components/edit/SettingsScreen.island";
import { loadSpaceSettingsContext } from "./_components/edit/settings-state";
import { parseSpaceSettings } from "./_components/settings/SpaceSettingsStore";
import { spaceMessages } from "./messages";

/** The settings of a Space on v2, a page of its own: the server loads what the person may see and change. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = spaceMessages.resolve([locale]);
  const spaceShortId = c.req.param("id") ?? "";
  const spaceId = ResourceShortIdSchema.safeParse(spaceShortId).success
    ? await spacesPublicResources.resolvePublicId("spaces", spaceShortId)
    : null;
  const back = { action: { label: t.allSpaces, href: "/app/spaces" } };
  if (!spaceId) return ssr.error(c, 404, back);
  const user = expectUserBackedActor(c);
  const cookie = c.req.header("Cookie");
  const dateConfig = getDateConfig(c);
  const [context, sidebar] = await Promise.all([
    loadSpaceSettingsContext({ locale, user, spaceId, settings: parseSpaceSettings(cookie, spaceShortId) }),
    loadSpacesSidebar({ userId: user.id, cookieHeader: cookie, dateConfig }),
  ]);
  if (!context.ok) return ssr.error(c, context.error.status === 403 ? 403 : 404, back);
  const tabs = visibleTabs(context.data.permission);
  const asked = SETTINGS_TABS.find((tab) => tab === c.req.query("tab"));
  // A tab the person may not open (or none) opens the first one they may.
  const tab = asked && tabs.includes(asked) ? asked : (tabs[0] ?? "defaults");
  const url = new URL(c.req.url);

  return () => (
    <Layout
      context={{ scope: { type: "spaces.space", id: context.data.space.id } }}
      c={c}
      help={spacesPageHelp.workspace}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: "Spaces", href: "/app/spaces" },
        { title: context.data.space.name, href: `/app/spaces/${spaceShortId}` },
        { title: t.spaceSettings },
      ]}
    >
      <SettingsScreen
        sidebar={sidebar}
        settings={context.data}
        tab={tab}
        baseUrl={`${url.protocol}//${url.host}`}
        dateConfig={dateConfig}
      />
    </Layout>
  );
});
