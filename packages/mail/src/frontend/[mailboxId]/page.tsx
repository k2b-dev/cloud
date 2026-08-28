import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { readThemeFromCookieHeader } from "@valentinkolb/cloud/shared";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import type { MailRequestContext } from "../../service";
import { getSpacesMailIntegrationAvailability } from "../../service/app-integrations";
import { loadMailboxPageData } from "../../service/workspace";
import { readMailUserPreferencesFromCookieHeader } from "../_components/mail-user-preferences";
import { readMailWorkspacePreferences } from "../_components/mail-workspace-preferences";
import MailWorkspace from "../MailWorkspace.island";
import { mailPageMessages } from "../pages-messages";
import { projectMailboxPageData, resolveSsrMailboxId, resolveSsrWorkspaceUrl } from "../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const { t } = mailPageMessages.resolve([getLocale(c)]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return c.redirect("/app/mail");
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (!user) return c.redirect("/app/mail");
  const requestUrl = new URL(c.req.raw.url);
  const internalRequestUrl = await resolveSsrWorkspaceUrl(requestUrl, mailboxId);
  if (!internalRequestUrl) return c.redirect(`/app/mail/${mailboxShortId}`);
  const context: MailRequestContext = {
    actor,
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const cookieHeader = c.req.header("cookie");
  const workspacePreferences = readMailWorkspacePreferences(cookieHeader);
  const userPreferences = readMailUserPreferencesFromCookieHeader(cookieHeader, mailboxShortId);
  const theme = readThemeFromCookieHeader(cookieHeader);
  const [internalData, spacesIntegration] = await Promise.all([
    loadMailboxPageData({ context, mailboxId, requestUrl: internalRequestUrl, listMode: workspacePreferences.listMode }),
    getSpacesMailIntegrationAvailability(),
  ]);
  if (!internalData) return c.redirect("/app/mail");
  const data = await projectMailboxPageData(internalData);
  const dateConfig = getDateConfig(c);

  return () => (
    <Layout
      c={c}
      fullPage
      workspaceSidebarCollapsible={false}
      title={[{ title: t.breadcrumbStart, href: "/" }, { title: t.breadcrumbMail, href: "/app/mail" }, { title: data.mailbox.name }]}
    >
      <MailWorkspace
        data={data}
        requestUrl={requestUrl.toString()}
        currentUserId={user.id}
        currentUserEmail={user.mail}
        dateConfig={dateConfig}
        initialPreferences={workspacePreferences}
        initialUserPreferences={userPreferences}
        initialTheme={theme}
        calendarIntegrationAvailable={spacesIntegration.invitations}
      />
    </Layout>
  );
});
