import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../../../config";
import type { MailRequestContext } from "../../../../service";
import { loadMailAutomationActivity } from "../../../../service/automation-workspace";
import MailAutomationActivityPage from "../../../MailAutomationActivityPage.island";
import { mailPageMessages } from "../../../pages-messages";
import { projectAutomationWorkspace, resolveSsrMailboxId } from "../../../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (!user) return ssr.error(c, 403);
  if (!mailboxShortId) return ssr.error(c, 404);
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return ssr.error(c, 404);
  const context: MailRequestContext = {
    actor,
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const result = await loadMailAutomationActivity(context, mailboxId, locale);
  if (!result.ok) return ssr.error(c, result.error.status);
  const data = await projectAutomationWorkspace(result.data);
  return () => (
    <Layout
      c={c}
      fullPage
      workspaceSidebarCollapsible={false}
      title={[
        { title: t.breadcrumbStart, href: "/" },
        { title: t.breadcrumbMail, href: "/app/mail" },
        { title: data.mailbox.name, href: `/app/mail/${mailboxShortId}` },
        { title: t.breadcrumbAutomations, href: `/app/mail/${mailboxShortId}/automations` },
        { title: t.breadcrumbActivity },
      ]}
    >
      <MailAutomationActivityPage data={data} currentUserEmail={user.mail} />
    </Layout>
  );
});
