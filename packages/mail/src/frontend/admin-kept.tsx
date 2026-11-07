import { type AuthContext, getDateConfig, getLocale } from "@k2b/cloud/server";
import { AdminLayout } from "@k2b/cloud/ssr";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { dates } from "@k2b/stdlib";
import { ButtonLink, DataTable, Placeholder } from "@k2b/ui";
import { ssr } from "../config";
import type { MailRequestContext } from "../service";
import { localizeMailError } from "../service/error-messages";
import { listKeptConversations } from "../service/kept-conversations";
import { publicIds } from "../service/public-resources";
import MailAdminKeptTable, { type KeptTableRow } from "./_components/MailAdminKeptTable.island";
import { MailAdminTabs } from "./admin-tabs";
import { mailKeptAdminMessages } from "./kept-admin-messages";

const PAGE_SIZE = 50;

const listHref = (params: Record<string, string | undefined>): string => {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  return query ? `/admin/mail/kept?${query}` : "/admin/mail/kept";
};

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
  const cursor = c.req.query("cursor") || undefined;
  const result = await listKeptConversations(context, { q: query || undefined, cursor, limit: PAGE_SIZE });
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
  const rows: KeptTableRow[] = (page?.items ?? []).flatMap((item) => {
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
        senderName: item.sender?.name?.trim() || null,
        senderAddress: item.sender?.address ?? null,
        date: item.lastMessageAt ? dates.formatDate(item.lastMessageAt, dateConfig) : "—",
        dateTitle: item.lastMessageAt ? dates.formatDateTime(item.lastMessageAt, dateConfig) : null,
        dateTime: item.lastMessageAt,
        keptBy: item.keptBy.displayName,
        keptSince: dates.formatDate(item.keptAt, dateConfig),
        keptSinceTitle: dates.formatDateTime(item.keptAt, dateConfig),
        keptSinceTime: item.keptAt,
      },
    ];
  });

  return () => (
    <AdminLayout c={c} title="Mail">
      <div class="app-rows" data-scroll-preserve="mail-admin-kept">
        <MailAdminTabs locale={locale} current="kept" keptCount={query || cursor ? undefined : page?.total} />
        <div>
          <h1 class="text-base font-semibold text-primary">{t.title}</h1>
          <p class="mt-1 max-w-3xl text-xs text-dimmed">{t.description}</p>
        </div>

        {page ? (
          <DataTable.Panel class="overflow-hidden">
            <DataTable.Header
              title={t.title}
              as="h2"
              subtitle={query ? t.filteredCount({ count: rows.length, total: page.total }) : t.count({ count: page.total })}
            />
            <DataTable.Controls>
              <SearchBar
                action="/admin/mail/kept"
                value={query}
                param="q"
                pageParam="cursor"
                placeholder={t.searchPlaceholder}
                ariaLabel={t.searchLabel}
              />
            </DataTable.Controls>
            <MailAdminKeptTable
              rows={rows}
              emptyTitle={query ? t.noMatches({ query }) : t.empty}
              emptyDescription={query ? null : t.emptyDescription}
            />
            {cursor || page.nextCursor ? (
              <div class="flex justify-center gap-2 px-3 py-3">
                {cursor ? (
                  <ButtonLink variant="subtle" size="sm" href={listHref({ q: query })}>
                    {t.firstPage}
                  </ButtonLink>
                ) : null}
                {page.nextCursor ? (
                  <ButtonLink variant="secondary" size="sm" href={listHref({ q: query, cursor: page.nextCursor })}>
                    {t.nextPage}
                  </ButtonLink>
                ) : null}
              </div>
            ) : null}
          </DataTable.Panel>
        ) : (
          <Placeholder
            state="error"
            variant="panel"
            title={t.loadFailed}
            description={result.ok ? undefined : localizeMailError(result.error, locale).message}
            action={
              <ButtonLink variant="secondary" size="sm" href={listHref({ q: query, cursor })}>
                {t.tryAgain}
              </ButtonLink>
            }
          />
        )}
      </div>
    </AdminLayout>
  );
});
