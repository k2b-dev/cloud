import { type AuthContext, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../../../config";
import type { MailRequestContext } from "../../../../service";
import { loadMailIncomingAutomationsWorkspace } from "../../../../service/automation-workspace";
import type { IncomingAutomationPreset } from "../../../_components/MailIncomingAutomationSettings";
import MailIncomingAutomationsPage from "../../../MailIncomingAutomationsPage.island";
import { mailPageMessages } from "../../../pages-messages";
import { projectAutomationWorkspace, resolveSsrMailboxId } from "../../../ssr-public-boundary";

const presets = new Set<IncomingAutomationPreset>(["blank", "ai-route", "ai-tag", "ai-draft"]);

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
  const result = await loadMailIncomingAutomationsWorkspace(context, mailboxId);
  if (!result.ok) return c.redirect(`/app/mail/${mailboxShortId}/automations`);
  const data = await projectAutomationWorkspace(result.data);
  const requested = c.req.query("new") ?? "";
  const openPreset = presets.has(requested as IncomingAutomationPreset)
    ? (requested as IncomingAutomationPreset)
    : requested === "1"
      ? "blank"
      : null;
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
        { title: t.breadcrumbIncomingMail },
      ]}
    >
      <MailIncomingAutomationsPage data={data} currentUserEmail={user.mail} openPreset={openPreset} />
    </Layout>
  );
});
