import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../../../config";
import type { MailRequestContext } from "../../../../service";
import { loadMailAutomaticRepliesWorkspace } from "../../../../service/automation-workspace";
import { isAutomaticReplyPresetId } from "../../../_components/MailAutomaticReplySettings";
import MailAutomaticRepliesPage from "../../../MailAutomaticRepliesPage.island";
import { mailPageMessages } from "../../../pages-messages";
import { projectAutomationWorkspace, resolveSsrMailboxId } from "../../../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const { t } = mailPageMessages.resolve([getLocale(c)]);
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
  const result = await loadMailAutomaticRepliesWorkspace(context, mailboxId);
  if (!result.ok) return c.redirect(`/app/mail/${mailboxShortId}/automations`);
  const data = await projectAutomationWorkspace(result.data);
  const requestedPreset = c.req.query("new");
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
        { title: t.breadcrumbAutomaticReplies },
      ]}
    >
      <MailAutomaticRepliesPage
        data={data}
        currentUserEmail={user.mail}
        initialPreset={isAutomaticReplyPresetId(requestedPreset) ? requestedPreset : null}
      />
    </Layout>
  );
});
