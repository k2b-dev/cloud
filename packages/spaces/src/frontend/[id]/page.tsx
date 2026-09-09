
import { type AuthContext, expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { ResourceShortIdSchema } from "../../contracts";
import { isMailInvitationIntegrationAvailable } from "../../service/mail-integration";
import { spacesPublicResources } from "../../service/public-resources";
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
  const [state, mailIntegrationAvailable] = await Promise.all([
    loadSpacesWorkspaceState({
      user: expectUserBackedActor(c),
      spaceId,
      spaceShortId,
      href: c.req.url,
      cookieHeader: c.req.header("Cookie"),
      authorizationHeader: c.req.header("Authorization"),
      dateConfig,
    }),
    isMailInvitationIntegrationAvailable(),
  ]);

  if (state.kind !== "ok") return ssr.error(c, state.kind === "accessDenied" ? 403 : 404, { description: state.message, action: { label: t.allSpaces, href: "/app/spaces" } });

  return () => (
    <Layout c={c} fullWidth title={state.title}>
      <SpacesWorkspace state={state} dateConfig={dateConfig} mailIntegrationAvailable={mailIntegrationAvailable} />
    </Layout>
  );
});
