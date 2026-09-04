import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../../../../config";
import { calendarInvitations, type MailRequestContext, mailboxAccess, mailboxes, senderIdentities } from "../../../../../service";
import MailDraftSeedComposerPage from "../../../../_components/MailDraftSeedComposerPage.island";
import { mailDraftReturnHref } from "../../../../_components/mail-compose-route";
import { readMailComposerPanesFromCookieHeader } from "../../../../_components/mail-composer-panes";
import { mailPageMessages } from "../../../../pages-messages";
import { projectComposeData, resolveSsrMailboxId } from "../../../../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const { t } = mailPageMessages.resolve([getLocale(c)]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const seedId = c.req.param("seedId") ?? "";
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return ssr.error(c, 404);
  const context: MailRequestContext = {
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const currentActor =
    context.actor.kind === "user"
      ? { kind: "user" as const, id: context.actor.user.id }
      : { kind: "service_account" as const, id: context.actor.serviceAccount.id };
  const [mailbox, permission, identities, calendarIntegrationAvailable] = await Promise.all([
    mailboxes.getMailbox(context, mailboxId),
    mailboxAccess.getMailboxPermission(context, mailboxId),
    senderIdentities.listSenderIdentities(context, mailboxId),
    calendarInvitations.composerIntegrationAvailable(),
  ]);
  if (!mailbox.ok) return ssr.error(c, mailbox.error.status);
  if (permission !== "write" && permission !== "admin") return ssr.error(c, 403);
  const publicData = await projectComposeData({ mailbox: mailbox.data, identities: identities.ok ? identities.data : [] });
  const returnHref = mailDraftReturnHref(c.req.query("return") ?? "", mailboxShortId);
  const popout = c.req.query("window") === "1";
  const initialPanes = readMailComposerPanesFromCookieHeader(c.req.header("cookie"));
  return () => (
    <Layout c={c} fullPage focusMode flushCanvas={popout} title={[{ title: t.breadcrumbMail, href: returnHref }, { title: t.newMessage }]}>
      <MailDraftSeedComposerPage
        mailboxId={mailboxShortId}
        currentActor={currentActor}
        seedId={seedId}
        identities={publicData.identities}
        initialPanes={initialPanes}
        returnHref={returnHref}
        popout={popout}
        dateConfig={getDateConfig(c)}
        canShareAttachments={permission === "admin"}
        calendarIntegrationAvailable={calendarIntegrationAvailable}
      />
    </Layout>
  );
});
