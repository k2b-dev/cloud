import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { currentActorUser } from "../../../api/permissions";
import { withInitialGqlResults } from "../../../api/workspace-query-preview";
import { ssr } from "../../../config";
import { gridsService } from "../../../service";
import { listBaseAccess } from "../../../service/access";
import { SETTINGS_TABS, settingsHref } from "../../_components/frame/BaseSettings";
import BaseSettings from "../../_components/frame/BaseSettings.island";
import { frameMessages } from "../../_components/frame/messages";
import RememberGridsPath from "../../_components/sidebar/RememberGridsPath.island";
import { projectPublicWorkspaceState } from "../../_components/workspace/workspace-public-state";
import { loadGridsWorkspaceState } from "../../_components/workspace/workspace-state";
import { serializeWorkspaceState } from "../../_components/workspace/workspace-state-serialization";
import { loadBaseChoices } from "../../base-choices";
import { resolveGridsMessages } from "../../messages";
import { gridsPageScope } from "../../page-context";

/**
 * A base's settings as a page of its own: `/settings` is General, `/settings/<tab>` the others. Only who manages the
 * base opens it; the server reads what the open tab shows (the access list only for Access).
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = resolveGridsMessages(locale);
  const user = currentActorUser(c);
  if (!user) return ssr.error(c, 403, { description: t.signInToOpenGrids });
  const baseShortId = c.req.param("baseId")!;
  const requested = c.req.param("tab");
  const tab = SETTINGS_TABS.find((each) => each === requested);
  // `/settings/general` and an unknown tab open the page's own address of General
  if (requested !== undefined && (!tab || tab === "general")) return c.redirect(settingsHref(baseShortId, "general"), 302);

  const loaded = await serializeWorkspaceState(
    baseShortId,
    async () => {
      const loadedState = await loadGridsWorkspaceState({
        user,
        baseShortId,
        href: new URL(`/app/grids/${baseShortId}`, c.req.url).href,
        activeTableSlug: null,
        dateConfig: await getDateConfig(c),
        locale,
      });
      return {
        loadedState,
        state: loadedState.kind === "ok" ? await projectPublicWorkspaceState(await withInitialGqlResults(c, loadedState), locale) : null,
      };
    },
    c.req.raw.signal,
  );
  const { loadedState, state } = loaded;
  if (loadedState.kind === "redirect") return c.redirect(loadedState.href, 302);
  if (loadedState.kind !== "ok" || !state)
    return ssr.error(c, loadedState.kind === "accessDenied" ? 403 : 404, {
      description: loadedState.kind === "accessDenied" ? t.askBaseAdminForAccess : t.baseUnavailable,
      action: { label: t.openGrids, href: "/app/grids" },
    });
  // the settings belong to who manages the base
  if (!state.canManageBase) return ssr.error(c, 403, { description: t.askBaseAdminForAccess });

  const access = tab === "access" ? await listBaseAccess(loadedState.base.id, "admin") : undefined;
  const bases = {
    ...(await loadBaseChoices({ userId: user.id, userGroups: user.memberofGroupIds }, c.req.header("Cookie"), locale)),
    templates: gridsService.template.list(locale),
    create: null,
    canCreate: true,
  };
  const words = frameMessages.resolve([locale]).t;
  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[...state.title, { title: words.settingsTabs }]}
      context={{ scope: gridsPageScope(state.base.id, null) }}
    >
      <RememberGridsPath />
      <BaseSettings state={state} tab={tab ?? "general"} access={access} bases={bases} />
    </Layout>
  );
});
