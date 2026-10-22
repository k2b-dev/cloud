import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { ResourceShortIdSchema } from "../../contracts";
import { spacesPageHelp } from "../../help";
import { spacesService } from "../../service";
import { isMailInvitationIntegrationAvailable } from "../../service/mail-integration";
import { loadSpacesSidebar } from "../../service/overview";
import { spacesPublicResources } from "../../service/public-resources";
import { firstOpenSpacesHint, spaceHintCandidates } from "../spaces-hints";
import SpacesWorkspace from "./_components/workspace/SpacesWorkspace";
import { loadSpacesWorkspaceState } from "./_components/workspace/workspace-state";
import { spaceMessages } from "./messages";

export default ssr<AuthContext>(async (c) => {
  const { t } = spaceMessages.resolve([getLocale(c)]);
  const spaceShortId = c.req.param("id") ?? "";
  const spaceId = ResourceShortIdSchema.safeParse(spaceShortId).success
    ? await spacesPublicResources.resolvePublicId("spaces", spaceShortId)
    : null;
  const dateConfig = getDateConfig(c);
  if (!spaceId) return ssr.error(c, 404, { action: { label: t.allSpaces, href: "/app/spaces" } });
  const user = expectUserBackedActor(c);
  const statePromise = loadSpacesWorkspaceState({
    user,
    spaceId,
    spaceShortId,
    href: c.req.url,
    cookieHeader: c.req.header("Cookie"),
    authorizationHeader: c.req.header("Authorization"),
    dateConfig,
  });
  // The existing assignee directory requires write permission; read-only users do not receive it.
  const peoplePromise = statePromise.then((state) =>
    state.kind === "ok" && state.canWrite ? spacesService.item.listAssignableUsers({ spaceId, search: "", limit: 20 }) : [],
  );
  const [state, mailIntegrationAvailable, sidebar, people] = await Promise.all([
    statePromise,
    isMailInvitationIntegrationAvailable(),
    loadSpacesSidebar({ userId: user.id, cookieHeader: c.req.header("Cookie"), dateConfig }),
    peoplePromise,
  ]);

  if (state.kind !== "ok")
    return ssr.error(c, state.kind === "accessDenied" ? 403 : 404, {
      description: state.message,
      action: { label: t.allSpaces, href: "/app/spaces" },
    });

  const openHint = firstOpenSpacesHint(c, spaceHintCandidates(sidebar.spaces.length));
  const hints = {
    sidebarSwitch: openHint === "spaces.sidebar-switch",
    viewTabs: openHint === "spaces.view-tabs",
    spaceMenu: openHint === "spaces.space-menu",
  };

  return () => (
    <Layout
      context={{ scope: { type: "spaces.space", id: state.space.id } }}
      c={c}
      help={spacesPageHelp.workspace}
      fullWidth
      title={state.title}
    >
      <SpacesWorkspace
        userId={user.id}
        state={state}
        dateConfig={dateConfig}
        mailIntegrationAvailable={mailIntegrationAvailable}
        sidebar={sidebar}
        hints={hints}
        people={people}
      />
    </Layout>
  );
});
