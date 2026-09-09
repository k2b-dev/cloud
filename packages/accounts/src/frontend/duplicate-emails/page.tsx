import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Pagination, Paper, Placeholder, Tag } from "@k2b/ui";
import { accountCategoryLabel } from "@valentinkolb/cloud/contracts";
import { type AuthContext, expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { accountsAppService, coreSettings, readAccountCategoryPolicy } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { HTTPException } from "hono/http-exception";
import { ssr } from "../../config";
import { toAccountsActor } from "../../shared/actor";
import AccountsWorkspace from "../AccountsWorkspace";
import { parseUsersListState } from "../lib/url-state";
import { accountsMessages } from "../messages";
import DeleteDuplicateUser from "./DeleteDuplicateUser.island";

export default ssr<AuthContext>(async (c) => {
  const { locale, t } = accountsMessages.resolve([getLocale(c)]);
  const actor = expectUserBackedActor(c);
  const requestedPage = parseUsersListState({ page: c.req.query("page") }).page;
  const [result, pending, policy, freeIpaEnabled] = await Promise.all([
    accountsAppService.user.listDuplicateEmails({ actor: toAccountsActor(actor), pagination: { page: requestedPage, perPage: 100 } }),
    accountsAppService.accountRequest.list({ access: { userId: actor.id, isAdmin: true }, filter: { status: "pending" } }),
    readAccountCategoryPolicy(),
    coreSettings.get<boolean>("freeipa.enable"),
  ]);
  if (!result.ok) throw new HTTPException(403, { message: result.error.message });
  const page = result.data;
  // Deleting the last group on a page can reduce the page count.
  if (page.page !== requestedPage) return c.redirect(`/app/accounts/duplicate-emails?page=${page.page}`);
  type UserRow = (typeof page.items)[number]["users"][number];
  const timestamp = (value: string | null) => (value ? dates.formatDateTime(value, { locale, timeZone: "UTC" }) : t.loginNotRecorded);
  const columns: DataTableColumn<UserRow>[] = [
    { id: "user", header: t.user, value: (user) => user.displayName || user.uid },
    { id: "category", header: t.accountType, value: (user) => accountCategoryLabel(user, policy.login.label) },
    { id: "web", header: t.lastWebLogin, value: (user) => timestamp(user.lastLoginLocal) },
    { id: "kerberos", header: t.lastKerberosLogin, value: (user) => (user.provider === "ipa" ? timestamp(user.lastLoginIpa) : "—") },
    { id: "sync", header: t.duplicateLastSync, value: (user) => (user.provider === "ipa" ? timestamp(user.ipaSyncedAt) : "—") },
    { id: "expiry", header: t.accountExpires, value: (user) => (user.accountExpires ? timestamp(user.accountExpires) : t.never) },
    { id: "actions", header: t.actions, value: () => "" },
  ];
  return () => (
    <Layout c={c} fullWidth title={[{ title: t.accounts, href: "/app/accounts" }, { title: t.duplicateEmails }]}>
      <AccountsWorkspace
        active="duplicate-emails"
        isAdmin={true}
        pendingRequests={pending.total}
        scrollPreserveKey="accounts-duplicate-emails"
      >
        <div class="flex flex-col gap-4">
          <div>
            <h1 class="text-base font-semibold text-primary">{t.duplicateEmails}</h1>
            <p class="mt-1 text-sm text-dimmed">{t.duplicateEmailsDescription}</p>
            <p class="mt-1 text-sm text-dimmed">{t.duplicateLoginExplanation}</p>
            <p class="mt-2 text-xs text-dimmed">{t.duplicateEmailsCount({ count: page.total })}</p>
          </div>
          {page.items.length === 0 ? (
            <Placeholder surface="paper" description={t.duplicateEmailsEmpty} />
          ) : (
            page.items.map((group) => (
              <section aria-label={group.email} class="min-w-0">
                <h2 class="mb-2 break-words text-sm font-semibold text-primary">{group.email}</h2>
                <Paper class="overflow-hidden">
                  <DataTable
                    rows={group.users}
                    columns={columns}
                    getRowId={(user) => user.id}
                    ariaLabel={group.email}
                    class="overflow-x-auto"
                    renderCell={({ row: user, col, value, render }) => {
                      if (col.id === "user")
                        return (
                          <a href={`/app/accounts/users/${user.id}`} class="text-primary hover:underline">
                            <span class="block font-medium">{user.displayName || user.uid}</span>
                            <span class="block text-xs text-dimmed">
                              {user.uid} · {user.mail}
                            </span>
                          </a>
                        );
                      if (col.id === "category") return <Tag>{accountCategoryLabel(user, policy.login.label)}</Tag>;
                      if (col.id === "actions")
                        return (
                          <DeleteDuplicateUser
                            user={user}
                            disabled={user.id === actor.id || (user.provider === "ipa" && !freeIpaEnabled)}
                            disabledReason={user.id === actor.id ? t.cannotDeleteSelf : undefined}
                          />
                        );
                      return render(value);
                    }}
                  />
                </Paper>
              </section>
            ))
          )}
          <Pagination
            currentPage={page.page}
            totalPages={Math.max(1, Math.ceil(page.total / page.perPage))}
            baseUrl="/app/accounts/duplicate-emails?page="
          />
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
