import { PANEL_HELP_ID_MAX_LENGTH } from "@k2b/cloud/contracts/panel-context";
import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { canReadAppHelp } from "@k2b/cloud/services/help";
import { HELP_VIEW_LIMIT } from "@k2b/cloud/shared";
import { getDisplayRuntimeContext, getLocalizedRuntimeContext, LayoutHelpPanel, PanelLayout, readPanelContext } from "@k2b/cloud/ssr";
import { appAppearanceStyle } from "@k2b/cloud/ssr/app-appearance";
import { layoutHelpFailed, preloadLayoutHelp, preloadLayoutHelpArticle } from "@k2b/cloud/ssr/help";
import { keyboardPlatform } from "@k2b/ui";
import { loadCodeHelpReference } from "../../code/help-reference";
import { ssr } from "../../config";
import { corePageMessages } from "../messages";
import { CodeHelpSection } from "./CodeHelpSection";

export default ssr<AuthContext>(async (c) => {
  const { t } = corePageMessages.resolve([getLocale(c)]);
  const context = readPanelContext(c);
  const id = context?.app ?? "core";
  // Context selects Help; the reader's grants still decide whether the app exists for them.
  const visibleIds = new Set(getDisplayRuntimeContext(c).apps.map((app) => app.id));
  const candidate = getLocalizedRuntimeContext(c).apps.find((app) => visibleIds.has(app.id) && app.id === id);
  // Runtime metadata lifts adminHref out of registry navigation; restore it for the shared reader's visibility rule.
  const nav = candidate?.adminHref
    ? { ...candidate.nav, href: candidate.nav?.href ?? "", section: candidate.nav?.section ?? "hidden", adminHref: candidate.adminHref }
    : candidate?.nav;
  const app = candidate && (candidate.access !== undefined || canReadAppHelp({ nav }, c.get("actor"))) ? candidate : undefined;
  // Generated from the same catalog as Gustav's code_sdk; only for people who can write Code. Loads beside the Help.
  const codeReference =
    app && c.get("actor") && c.get("accessSubject") && c.get("credentialKind")
      ? loadCodeHelpReference(app.id, { authority: auth.getAuthority(c), locale: getLocale(c), signal: c.req.raw.signal })
      : null;
  const [help, code] = await Promise.all([app?.help ? preloadLayoutHelp(c, app.id) : null, codeReference]);
  const documents = help?.documents ?? [];
  const ids = new Set(documents.map((document) => document.id));
  const view = context?.app === app?.id ? [...new Set(context?.help ?? [])].filter((id) => ids.has(id)).slice(0, HELP_VIEW_LIMIT) : [];
  const requested = c.req.query("topic");
  const initialTopic =
    requested && requested.length <= PANEL_HELP_ID_MAX_LENGTH && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(requested) && ids.has(requested)
      ? requested
      : undefined;
  const initialArticle = initialTopic && app ? await preloadLayoutHelpArticle(c, app.id, initialTopic) : null;
  const state = !app ? "unavailable" : !help && layoutHelpFailed(c) ? "failed" : undefined;
  const url = new URL(c.req.url);
  const platform = keyboardPlatform(c.req.header("User-Agent") ?? "");
  return () => (
    <PanelLayout c={c} title={t.help}>
      <LayoutHelpPanel
        documents={documents}
        app={app ? { id: app.id, name: app.name, icon: app.icon } : undefined}
        appearance={app ? appAppearanceStyle(app.appearance) : undefined}
        view={view}
        initialTopic={initialTopic}
        initialArticle={initialArticle ?? undefined}
        pageBase={help?.pageBase}
        platform={platform}
        state={state}
        startSection={
          app && code ? <CodeHelpSection reference={code} appName={app.name} reloadHref={`${url.pathname}${url.search}`} /> : undefined
        }
      />
    </PanelLayout>
  );
});
