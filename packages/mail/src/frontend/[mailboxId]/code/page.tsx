import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout, loadCodePage } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import type { MailRequestContext } from "../../../service";
import { requestContactDirectory } from "../../../service/contact-directory";
import { loadMailboxCodePageData } from "../../../service/workspace";
import MailboxCode from "../../MailboxCode.island";
import { loadMailSidebarData } from "../../mail-sidebar-data";
import { mailPageMessages } from "../../pages-messages";
import { projectMailboxCodePageData, resolveSsrMailboxId } from "../../ssr-public-boundary";

/** The mailbox's Code: Mail checks the mailbox; Core decides which Code the person sees and may change. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return ssr.error(c, 404);
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (!user) return ssr.error(c, 403);
  const context: MailRequestContext = {
    actor,
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const [internal, sidebar] = await Promise.all([loadMailboxCodePageData(context, mailboxId), loadMailSidebarData(context)]);
  if (!internal.ok) return ssr.error(c, internal.error.status);
  const mailbox = await projectMailboxCodePageData(internal.data);
  const ref = { type: "mail.mailbox", id: mailbox.mailbox.id };
  const [code, directory] = await Promise.all([
    loadCodePage(c, {
      owner: { ref, title: mailbox.mailbox.name },
      href: `/app/mail/${mailbox.mailbox.id}/code`,
      // Mailbox administrators may create and switch on its Code; Core checks this again on every change.
      canManageOwner: mailbox.access.scope === "mailbox" && mailbox.access.permission === "admin",
    }),
    requestContactDirectory(c),
  ]);
  return () => (
    <Layout
      c={c}
      context={{ scope: ref }}
      printHint={t.printHint}
      fullPage
      workspaceSidebarCollapsible={false}
      title={[
        { title: t.breadcrumbStart, href: "/" },
        { title: t.breadcrumbMail, href: "/app/mail" },
        { title: mailbox.mailbox.name, href: `/app/mail/${mailbox.mailbox.id}` },
        { title: t.breadcrumbCode },
      ]}
    >
      <MailboxCode mailbox={mailbox} sidebar={sidebar} code={code} currentUserEmail={user.mail} contactDirectory={directory} />
    </Layout>
  );
});
