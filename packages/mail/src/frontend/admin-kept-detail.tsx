import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { ButtonLink, Placeholder } from "@k2b/ui";
import { Show } from "solid-js";
import { ssr } from "../config";
import type { MailRequestContext } from "../service";
import { localizeMailError } from "../service/error-messages";
import { getKeptConversation, type KeepHistoryEntry } from "../service/kept-conversations";
import { resolveMailboxPublicId, resolvePublicId } from "../service/public-resources";
import MailAdminKeptDetail from "./_components/MailAdminKeptDetail";
import { MailAdminTabs } from "./admin-tabs";
import { mailKeptAdminMessages } from "./kept-admin-messages";

export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailKeptAdminMessages.resolve([locale]);
  const dateConfig = getDateConfig(c);
  const context: MailRequestContext = {
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const mailboxPublicId = c.req.param("mailboxId") ?? "";
  const conversationPublicId = c.req.param("conversationId") ?? "";
  const mailboxId = await resolvePublicId("mailboxes", mailboxPublicId);
  const conversationId = mailboxId ? await resolveMailboxPublicId("conversations", mailboxId, conversationPublicId) : null;
  const result = mailboxId && conversationId ? await getKeptConversation(context, { mailboxId, conversationId }) : null;
  if (result && !result.ok && result.error.code === "FORBIDDEN") return ssr.error(c, 403);
  const conversation = result?.ok ? result.data.document.conversations[0] : undefined;
  const history: KeepHistoryEntry[] = result?.ok ? result.data.history : [];
  const messageCount = result?.ok ? result.data.messageCount : 0;
  const notFound = !result || (!result.ok && result.error.code === "NOT_FOUND");

  return () => (
    <AdminLayout c={c} title="Mail">
      <div class="app-rows" data-scroll-preserve="mail-admin-kept-detail">
        <MailAdminTabs locale={locale} current="kept" />
        <Show
          when={conversation}
          fallback={
            <Placeholder
              state="error"
              variant="panel"
              title={notFound ? t.detailNotFound : t.detailLoadFailed}
              description={result && !result.ok && !notFound ? localizeMailError(result.error, locale).message : undefined}
              action={
                <ButtonLink variant="secondary" size="sm" href={notFound ? "/admin/mail/kept" : c.req.path}>
                  {notFound ? t.backToList : t.tryAgain}
                </ButtonLink>
              }
            />
          }
        >
          {(kept) => <MailAdminKeptDetail conversation={kept()} history={history} messageCount={messageCount} dateConfig={dateConfig} />}
        </Show>
      </div>
    </AdminLayout>
  );
});
