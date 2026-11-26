import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import type { MailRequestContext } from "../service";
import { localizeMailError } from "../service/error-messages";
import { getKeptConversation } from "../service/kept-conversations";
import { resolveMailboxPublicId, resolvePublicId } from "../service/public-resources";
import MailAdminKeptRecord from "./_components/v2/MailAdminKeptRecord.island";
import { mailAdminSections } from "./admin-sections";
import { mailKeptAdminMessages } from "./kept-admin-messages";

/** One kept conversation in Cloud administration › Mail › Kept on v2. Opening it is logged by the service. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailKeptAdminMessages.resolve([locale]);
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
  const notFound = !result || (!result.ok && result.error.code === "NOT_FOUND") || (result.ok && !conversation);

  return () => (
    <AdminLayout c={c} title={t.title} ui="v2">
      <MailAdminKeptRecord
        nav={adminNavigation(c, mailAdminSections(locale, "kept"))}
        record={
          result?.ok && conversation ? { conversation, history: result.data.history, messageCount: result.data.messageCount } : undefined
        }
        missing={
          conversation
            ? undefined
            : notFound || !result || result.ok
              ? { notFound: true }
              : { notFound: false, text: `${t.detailLoadFailed}: ${localizeMailError(result.error, locale).message}` }
        }
        dateConfig={getDateConfig(c)}
      />
    </AdminLayout>
  );
});
