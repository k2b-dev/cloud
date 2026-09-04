import { type AuthContext, getDateConfig, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../../../config";
import { calendarInvitations, drafts, type MailRequestContext, mailboxAccess, mailboxes, senderIdentities } from "../../../../service";
import MailComposerPage from "../../../_components/MailComposerPage.island";
import { mailDraftReturnHref } from "../../../_components/mail-compose-route";
import { readMailComposerPanesFromCookieHeader, reconcileMailComposerPanes } from "../../../_components/mail-composer-panes";
import { mailPageMessages } from "../../../pages-messages";
import { projectComposeData, resolveSsrMailboxId, resolveSsrMailboxResourceId } from "../../../ssr-public-boundary";

export default ssr<AuthContext>(async (c) => {
  const { t } = mailPageMessages.resolve([getLocale(c)]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const draftShortId = c.req.param("draftId") ?? "";
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return ssr.error(c, 404);
  const draftId = await resolveSsrMailboxResourceId("drafts", mailboxId, draftShortId);
  if (!draftId) return ssr.error(c, 404);
  const context: MailRequestContext = {
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const currentActor =
    context.actor.kind === "user"
      ? { kind: "user" as const, id: context.actor.user.id }
      : { kind: "service_account" as const, id: context.actor.serviceAccount.id };
  const [mailbox, permission, identities, draft, calendarIntegrationAvailable] = await Promise.all([
    mailboxes.getMailbox(context, mailboxId),
    mailboxAccess.getMailboxPermission(context, mailboxId),
    senderIdentities.listSenderIdentities(context, mailboxId),
    drafts.getDraft(context, mailboxId, draftId),
    calendarInvitations.composerIntegrationAvailable(),
  ]);
  if (!mailbox.ok) return ssr.error(c, mailbox.error.status);
  if (!draft.ok) return ssr.error(c, draft.error.status);
  if (permission !== "write" && permission !== "admin") return ssr.error(c, 403);
  const publicData = await projectComposeData({
    mailbox: mailbox.data,
    identities: identities.ok ? identities.data : [],
    draft: draft.data,
  });
  const returnHref = mailDraftReturnHref(c.req.query("return") ?? "", mailboxShortId);
  const popout = c.req.query("window") === "1";
  const initialPanes = reconcileMailComposerPanes(
    readMailComposerPanesFromCookieHeader(c.req.header("cookie")),
    draft.data.format,
    Boolean(draft.data.conversationId),
  );
  return () => (
    <Layout
      c={c}
      fullPage
      focusMode
      flushCanvas={popout}
      title={[{ title: t.breadcrumbMail, href: returnHref }, { title: draft.data.subject || t.draft }]}
    >
      <MailComposerPage
        mailboxId={mailboxShortId}
        currentActor={currentActor}
        identities={publicData.identities}
        initialDraft={publicData.draft}
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
