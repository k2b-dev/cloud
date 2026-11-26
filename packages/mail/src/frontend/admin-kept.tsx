import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout, adminNavigation } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { ssr } from "../config";
import type { MailRequestContext } from "../service";
import { localizeMailError } from "../service/error-messages";
import { listKeptConversations } from "../service/kept-conversations";
import { publicIds } from "../service/public-resources";
import MailAdminKeptList, { type MailAdminKeptRow } from "./_components/v2/MailAdminKeptList.island";
import { mailAdminSections } from "./admin-sections";
import { mailKeptAdminMessages } from "./kept-admin-messages";

const PAGE_SIZE = 50;

/** Cloud administration › Mail › Kept on v2: every kept conversation of every mailbox, 50 a page, newest keep first. */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = mailKeptAdminMessages.resolve([locale]);
  const dateConfig = getDateConfig(c);
  const context: MailRequestContext = {
    actor: c.get("actor"),
    accessSubject: c.get("accessSubject"),
    requestId: c.req.header("x-request-id") ?? null,
  };
  const query = (c.req.query("q") ?? "").trim();
  const cursor = c.req.query("cursor") || null;
  const result = await listKeptConversations(context, { q: query || undefined, cursor: cursor ?? undefined, limit: PAGE_SIZE });
  if (!result.ok && result.error.code === "FORBIDDEN") return ssr.error(c, 403);
  const page = result.ok ? result.data : null;
  const [mailboxIds, conversationIds] = page
    ? await Promise.all([
        publicIds(
          "mailboxes",
          page.items.map((item) => item.mailboxId),
        ),
        publicIds(
          "conversations",
          page.items.map((item) => item.conversationId),
        ),
      ])
    : [new Map<string, string>(), new Map<string, string>()];
  const rows: MailAdminKeptRow[] = (page?.items ?? []).flatMap((item) => {
    const mailboxId = mailboxIds.get(item.mailboxId);
    const conversationId = conversationIds.get(item.conversationId);
    if (!mailboxId || !conversationId) return [];
    return [
      {
        mailboxId,
        conversationId,
        href: `/admin/mail/kept/${mailboxId}/${conversationId}`,
        mailboxName: item.mailboxName,
        mailboxDeleted: item.mailboxDeleted,
        subject: item.subject?.trim() || t.noSubject,
        sender: { name: item.sender?.name?.trim() || null, address: item.sender?.address ?? null },
        date: item.lastMessageAt
          ? {
              text: dates.formatDate(item.lastMessageAt, dateConfig),
              title: dates.formatDateTime(item.lastMessageAt, dateConfig),
              iso: item.lastMessageAt,
            }
          : null,
        keptBy: item.keptBy.displayName,
        keptSince: { text: dates.formatDate(item.keptAt, dateConfig), title: dates.formatDateTime(item.keptAt, dateConfig), iso: item.keptAt },
      },
    ];
  });

  return () => (
    <AdminLayout c={c} title="Mail" ui="v2">
      <MailAdminKeptList
        nav={adminNavigation(c, mailAdminSections(locale, "kept"))}
        rows={rows}
        total={page?.total ?? null}
        failure={result.ok ? null : `${t.loadFailed}: ${localizeMailError(result.error, locale).message}`}
        query={query}
        cursor={cursor}
        nextCursor={page?.nextCursor ?? null}
      />
    </AdminLayout>
  );
});
