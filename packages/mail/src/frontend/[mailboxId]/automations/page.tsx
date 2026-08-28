import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../../config";
import type { MailRequestContext } from "../../../service";
import { loadMailAutomationOverview } from "../../../service/automation-workspace";
import MailAutomationOverview from "../../MailAutomationOverview.island";
import { mailPageMessages } from "../../pages-messages";
import { projectAutomationWorkspace, resolveSsrMailboxId } from "../../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (!mailboxShortId || !user) return c.redirect("/app/mail");
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return c.redirect("/app/mail");

  const context: MailRequestContext = {
    actor,
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const result = await loadMailAutomationOverview(context, mailboxId, locale);
  if (!result.ok) return c.redirect(`/app/mail/${mailboxShortId}`);
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
        { title: t.breadcrumbAutomations },
      ]}
    >
      <MailAutomationOverview data={data} currentUserEmail={user.mail} />
    </Layout>
  );
});
