import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { MarkdownView } from "@k2b/ui";
import { For, Show } from "solid-js";
import { ssr } from "../../../../config";
import type { MailAddress } from "../../../../contracts";
import { drafts } from "../../../../service";
import { mailConversationUiMessages } from "../../../_components/mail-conversation-ui-messages";
import { mailPageMessages } from "../../../pages-messages";
import { resolveSsrMailboxId, resolveSsrMailboxResourceId } from "../../../ssr-public-boundary";

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
  const result = await drafts.getDraft(
    { actor: c.get("actor"), accessSubject: c.get("accessSubject"), requestId: c.req.header("x-request-id") ?? null },
    mailboxId,
    draftId,
  );
  if (!result.ok) return ssr.error(c, result.error.status);
  const draft = result.data;
  const subject = draft.subject || ui.noSubject;
  const recipients = [
    { label: ui.to, value: addressList(draft.to) || ui.noRecipients },
    { label: "Cc", value: addressList(draft.cc) },
    { label: "Bcc", value: addressList(draft.bcc) },
  ].filter((row) => row.value);
  return () => (
    <Layout c={c} title={[{ title: t.breadcrumbMail, href: `/app/mail/${encodeURIComponent(mailboxShortId)}` }, { title: subject }]}>
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
        <Show when={draft.body.trim()} fallback={<p class="text-sm text-dimmed">{ui.noMessageBody}</p>}>
          <Show
            when={draft.format === "markdown"}
            fallback={<p class="whitespace-pre-wrap break-words text-sm leading-6 text-primary">{draft.body}</p>}
          >
            <MarkdownView markdown={draft.body} />
          </Show>
        </Show>
        <Show when={draft.attachments.length > 0}>
          <section class="flex flex-col gap-1">
            <h2 class="text-xs font-medium text-dimmed">{ui.attachments}</h2>
            <ul class="flex flex-col gap-1 text-sm text-secondary">
              <For each={draft.attachments}>
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
