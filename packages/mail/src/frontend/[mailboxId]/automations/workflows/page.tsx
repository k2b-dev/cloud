import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../../../config";
import type { MailRequestContext } from "../../../../service";
import { loadMailWorkflowsWorkspace } from "../../../../service/automation-workspace";
import MailWorkflowsPage from "../../../MailWorkflowsPage.island";
import { mailPageMessages } from "../../../pages-messages";
import { projectAutomationWorkspace, resolveSsrMailboxId } from "../../../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const { t } = mailPageMessages.resolve([getLocale(c)]);
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
  const result = await loadMailWorkflowsWorkspace(context, mailboxId);
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
        { title: t.breadcrumbWorkflows },
      ]}
    >
      <MailWorkflowsPage data={data} currentUserEmail={user.mail} openNew={c.req.query("new") === "1"} />
    </Layout>
  );
});
