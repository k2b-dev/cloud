import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../../../../config";
import { requestContactDirectory } from "../../../../contact-directory-settings";
import {
  calendarInvitations,
  drafts,
  draftUploads,
  type MailRequestContext,
  mailboxAccess,
  mailboxes,
  senderIdentities,
} from "../../../../service";
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
  const [mailbox, access, identities, draft, uploads, calendarIntegrationAvailable] = await Promise.all([
    mailboxes.getMailbox(context, mailboxId),
    // Assigned-only writers reply here too; the draft and seed services refuse anything they cannot see.
    mailboxAccess.requireMailboxAccess(context, mailboxId, "write"),
    senderIdentities.listSenderIdentities(context, mailboxId),
    drafts.getDraft(context, mailboxId, draftId),
    draftUploads.listUnfinishedDraftAttachmentUploads({ context, mailboxId, draftId }),
    calendarInvitations.composerIntegrationAvailable(),
  ]);
  if (!mailbox.ok) return ssr.error(c, mailbox.error.status);
  if (!draft.ok) return ssr.error(c, draft.error.status);
  if (!access.ok) return ssr.error(c, 403);
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
        unfinishedUploads={(uploads.ok ? uploads.data : []).map(({ id, filename, byteLength, receivedBytes }) => ({
          id,
          filename,
          byteLength,
          receivedBytes,
        }))}
        initialPanes={initialPanes}
        returnHref={returnHref}
        popout={popout}
        dateConfig={getDateConfig(c)}
        canShareAttachments={access.data.permission === "admin"}
        calendarIntegrationAvailable={calendarIntegrationAvailable}
        contactDirectory={requestContactDirectory(c)}
      />
    </Layout>
  );
});
