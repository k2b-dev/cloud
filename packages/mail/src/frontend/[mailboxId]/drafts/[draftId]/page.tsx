import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { MarkdownView } from "@k2b/ui";
import { For, Show } from "solid-js";
import { ssr } from "../../../../config";
import type { MailAddress } from "../../../../contracts";
import { drafts, mailboxes } from "../../../../service";
import { requireMailboxPermission } from "../../../../service/access";
import { loadSendReviewContent } from "../../../../service/capability-review-readers";
import { mailConversationUiMessages } from "../../../_components/mail-conversation-ui-messages";
import { MailDraftReviewChangedV2, MailDraftReviewV2 } from "../../../MailDraftReviewV2";
import { readMailV2Pilot, showsMailV2 } from "../../../mail-v2-pilot";
import { mailPageMessages } from "../../../pages-messages";
import { pageReadStatus, resolveSsrMailboxId, resolveSsrMailboxResourceId } from "../../../ssr-public-boundary";

const addressList = (addresses: MailAddress[]): string =>
  addresses.map((address) => (address.name ? `${address.name} <${address.address}>` : address.address)).join(", ");

/** The draft as its readers see it: members who may read but not write land here instead of in the composer. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailPageMessages.resolve([locale]);
  const { t: ui } = mailConversationUiMessages.resolve([locale]);
  const mailboxShortId = c.req.param("mailboxId") ?? "";
  const mailboxId = await resolveSsrMailboxId(mailboxShortId);
  if (!mailboxId) return ssr.error(c, 404);
  const draftId = await resolveSsrMailboxResourceId("drafts", mailboxId, c.req.param("draftId") ?? "");
  if (!draftId) return ssr.error(c, 404);
  const context = { actor: c.get("actor"), accessSubject: c.get("accessSubject"), requestId: c.req.header("x-request-id") ?? null, locale };
  // The way back names the mailbox it leads to; both reads refuse a caller without access to it.
  const [mailbox, result] = await Promise.all([mailboxes.getMailbox(context, mailboxId), drafts.getDraft(context, mailboxId, draftId)]);
  // Without access the page answers as for an unknown address, so it never tells that the mailbox or draft exists.
  if (!mailbox.ok) return ssr.error(c, await pageReadStatus(context, mailboxId, mailbox.error.status));
  if (!result.ok) return ssr.error(c, await pageReadStatus(context, mailboxId, result.error.status));
  const draft = result.data;
  const actor = c.get("actor");
  const user = actor.kind === "user" ? actor.user : actor.delegatedUser;
  // the same pilot as the mailbox page: who sees mailboxes on v2 also sees this page on v2
  const v2 = showsMailV2(readMailV2Pilot(c), user?.mail);
  const mailboxPlace = { name: mailbox.data.name, href: `/app/mail/${encodeURIComponent(mailboxShortId)}` };
  // On v2 a review whose version is gone says so in the page, with the way to the draft as it is now (still 409).
  const changed = () => {
    if (!v2) return ssr.error(c, 409, { title: t.reviewChanged, description: t.reviewChangedDescription });
    c.status(409);
    return () => (
      <Layout
        c={c}
        printHint={t.printHint}
        ui="v2"
        title={[{ title: mailbox.data.name, href: mailboxPlace.href }, { title: draft.subject || ui.noSubject }]}
      >
        <MailDraftReviewChangedV2
          mailbox={mailboxPlace}
          subject={draft.subject || ui.noSubject}
          title={t.reviewChanged}
          description={t.reviewChangedDescription}
          current={{ label: t.openCurrentDraft, href: new URL(c.req.url).pathname }}
        />
      </Layout>
    );
  };
  const revision = c.req.query("revision");
  // Review overflow links must show the exact effective message or fail visibly;
  // never replace a reviewed revision with today's raw draft.
  if (revision !== undefined && (!/^[1-9]\d*$/.test(revision) || Number(revision) !== draft.revision)) return changed();
  const sendHash = c.req.query("sendContent");
  if (sendHash !== undefined && (revision === undefined || !/^[a-f0-9]{64}$/.test(sendHash) || !draft.senderIdentityId)) return changed();
  const sendContent =
    sendHash !== undefined && draft.senderIdentityId
      ? await loadSendReviewContent({ context, mailboxId, draft, senderIdentityId: draft.senderIdentityId })
      : null;
  if (sendContent && !sendContent.ok) return ssr.error(c, sendContent.error.status);
  const content = sendContent?.ok ? sendContent.data : null;
  if (content && content.contentHash !== sendHash) return changed();
  const shown = content?.draft ?? draft;
  const subject = draft.subject || ui.noSubject;
  const recipients = [
    ...(content
      ? [{ label: ui.from, value: addressList([{ name: content.from.name ?? null, address: content.from.address ?? "" }]) }]
      : []),
    { label: ui.to, value: addressList(shown.to) || ui.noRecipients },
    { label: "Cc", value: addressList(shown.cc) },
    { label: "Bcc", value: addressList(shown.bcc) },
  ].filter((row) => row.value);
  // Without a version under review the page is the readers' way to a draft; it says so only to someone who cannot write.
  const readOnly = v2 && revision === undefined && !(await requireMailboxPermission(context, mailboxId, "write")).ok;
  if (v2)
    return () => (
      <Layout c={c} printHint={t.printHint} ui="v2" title={[{ title: mailbox.data.name, href: mailboxPlace.href }, { title: subject }]}>
        <MailDraftReviewV2
          mailbox={mailboxPlace}
          subject={subject}
          note={revision !== undefined ? t.draftReviewedRevision({ revision: draft.revision }) : readOnly ? t.draftReadOnly : null}
          facts={recipients}
          body={shown.body.trim() ? { format: shown.format === "markdown" ? "markdown" : "text", text: shown.body } : null}
          attachments={shown.attachments.map((attachment) => attachment.filename)}
          text={{ attachments: ui.attachments, noMessageBody: ui.noMessageBody, text: t.draftText }}
        />
      </Layout>
    );
  return () => (
    <Layout
      c={c}
      printHint={t.printHint}
      title={[{ title: mailbox.data.name, href: `/app/mail/${encodeURIComponent(mailboxShortId)}` }, { title: subject }]}
    >
      <article class="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {/* The shell's page title already shows the subject. */}
        <p class="flex items-center gap-2 text-xs font-medium text-dimmed">
          <i class="ti ti-file-pencil" aria-hidden="true" />
          {t.draft}
        </p>
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <For each={recipients}>
            {(row) => (
              <>
                <dt class="text-dimmed">{row.label}</dt>
                <dd class="min-w-0 break-words text-secondary">{row.value}</dd>
              </>
            )}
          </For>
        </dl>
        <Show when={shown.body.trim()} fallback={<p class="text-sm text-dimmed">{ui.noMessageBody}</p>}>
          <Show
            when={shown.format === "markdown"}
            fallback={<p class="whitespace-pre-wrap break-words text-sm leading-6 text-primary">{shown.body}</p>}
          >
            <MarkdownView markdown={shown.body} />
          </Show>
        </Show>
        <Show when={shown.attachments.length > 0}>
          <section class="flex flex-col gap-1">
            <h2 class="text-xs font-medium text-dimmed">{ui.attachments}</h2>
            <ul class="flex flex-col gap-1 text-sm text-secondary">
              <For each={shown.attachments}>
                {(attachment) => (
                  <li class="flex min-w-0 items-center gap-2">
                    <i class="ti ti-paperclip shrink-0 text-dimmed" aria-hidden="true" />
                    <span class="min-w-0 break-words">{attachment.filename}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </article>
    </Layout>
  );
});
