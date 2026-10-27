import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { appAccessAuthority, coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin, readThemePreferenceFromCookieHeader } from "@k2b/cloud/shared";
import { Layout, requestPath } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import { mailPageHelp } from "../../help";
import type { MailRequestContext } from "../../service";
import { getSpacesMailIntegrationAvailability } from "../../service/app-integrations";
import { requestContactDirectory } from "../../service/contact-directory";
import { loadMailboxPageData, resolveWorkspaceRequest } from "../../service/workspace";
import { readMailUserPreferencesFromCookieHeader } from "../_components/mail-user-preferences";
import { readMailWorkspacePreferences } from "../_components/mail-workspace-preferences";
import MailWorkspace from "../MailWorkspace.island";
import { loadMailSidebarData } from "../mail-sidebar-data";
import { mailPageMessages } from "../pages-messages";
import { projectMailboxPageData, resolveSsrMailboxId } from "../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return ssr.error(c, 404);
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (!user) return ssr.error(c, 403);
  const request = await resolveWorkspaceRequest(new URL(c.req.raw.url), mailboxId);
  if (!request) return c.redirect(`/app/mail/${mailboxShortId}`);
  const context: MailRequestContext = {
    actor,
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const cookieHeader = c.req.header("cookie");
  const workspacePreferences = readMailWorkspacePreferences(cookieHeader);
  const userPreferences = readMailUserPreferencesFromCookieHeader(cookieHeader, mailboxShortId);
  const themePreference = readThemePreferenceFromCookieHeader(cookieHeader);
  // The sidebar's mailboxes load beside the mailbox, so the page waits for neither one after the other.
  const [internalData, spacesIntegration, sidebar, appUrl] = await Promise.all([
    loadMailboxPageData({ context, mailboxId, ...request, listMode: workspacePreferences.listMode, locale }),
    getSpacesMailIntegrationAvailability(appAccessAuthority(c)),
    loadMailSidebarData(context),
    coreSettings.get<string>("app.url"),
  ]);
  if (!internalData.ok) return ssr.error(c, internalData.error.status);
  const data = await projectMailboxPageData(internalData.data);
  const dateConfig = getDateConfig(c);

  const directory = await requestContactDirectory(c);
  return () => (
    <Layout
      c={c}
      context={{ scope: { type: "mail.mailbox", id: data.mailbox.id } }}
      help={mailPageHelp.mailbox}
      printHint={t.printHint}
      fullPage
      workspaceSidebarCollapsible={false}
      title={[{ title: t.breadcrumbStart, href: "/" }, { title: t.breadcrumbMail, href: "/app/mail" }, { title: data.mailbox.name }]}
    >
      <MailWorkspace
        data={data}
        requestPath={requestPath(c)}
        cloudUrl={publicCloudOrigin(appUrl)}
        currentUserId={user.id}
        currentUserEmail={user.mail}
        contactDirectory={directory}
        dateConfig={dateConfig}
        initialPreferences={workspacePreferences}
        initialUserPreferences={userPreferences}
        initialTheme={themePreference === "system" ? null : themePreference}
        calendarIntegrationAvailable={spacesIntegration.invitations}
        sidebar={sidebar}
      />
    </Layout>
  );
});
