import { NoticeCard } from "@k2b/ui";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { accountsAppService as accountsService, coreSettings } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../../config";
import AccountsWorkspace from "../../AccountsWorkspace";
import { accountsMessages } from "../../messages";
import DenyRequest from "../DenyRequest.island";
import CreateUserForm from "./CreateUserForm.island";

type AccountRequest = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string | null;
  phone: string | null;
  comment: string | null;
};

export default ssr<AuthContext>(async (c) => {
  const { t } = accountsMessages.resolve([getLocale(c)]);
  const user = expectUserBackedActor(c);
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const requestId = c.req.query("request");
  let accountRequest: AccountRequest | null = null;
  const pendingRequestsPage = await accountsService.accountRequest.list({
    access: { userId: user.id, isAdmin: true },
    filter: { status: "pending" },
  });

  if (requestId) {
    const requestResult = await accountsService.accountRequest.get({
      id: requestId,
      access: {
        userId: user.id,
        isAdmin: true,
      },
    });

    if (requestResult.ok && requestResult.data.status === "pending") {
      const req = requestResult.data;
      accountRequest = {
        id: req.id,
        email: req.email,
        firstName: req.firstName,
        lastName: req.lastName,
        displayName: req.displayName,
        phone: req.phone,
        comment: req.comment,
      };
    }
  }

  return () => (
    <Layout
      c={c}
      title={[
        { title: t.start, href: "/" },
        { title: t.accounts, href: "/app/accounts" },
        { title: t.users, href: "/app/accounts/users" },
        { title: t.newUser },
      ]}
    >
      <AccountsWorkspace active="users" isAdmin={true} pendingRequests={pendingRequestsPage.total} scrollPreserveKey="accounts-user-new">
        <div class="max-w-2xl mx-auto w-full">
          {accountRequest && (
            <div class="mb-4 flex flex-col gap-3 rounded-[var(--ui-radius-surface)] bg-amber-500/[0.08] p-4">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-semibold text-primary flex items-center gap-2">
                  <i class="ti ti-user-plus text-amber-500" />
                  {t.freeIpaAccessRequest}
                </h3>
                <DenyRequest requestId={accountRequest.id} email={accountRequest.email} firstName={accountRequest.firstName} />
              </div>

              <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt class="text-dimmed">{t.name}</dt>
                <dd class="text-primary font-medium">
                  {accountRequest.displayName || `${accountRequest.firstName} ${accountRequest.lastName}`}
                </dd>
                <dt class="text-dimmed">{t.email}</dt>
                <dd class="text-secondary">{accountRequest.email}</dd>
                {accountRequest.phone && (
                  <>
                    <dt class="text-dimmed">{t.phone}</dt>
                    <dd class="text-secondary">{accountRequest.phone}</dd>
                  </>
                )}
              </dl>

              {accountRequest.comment && (
                <NoticeCard tone="warning" icon={false}>
                  <p class="text-[10px] font-semibold mb-1 flex items-center gap-1">
                    <i class="ti ti-message text-xs" />
                    {t.requesterNote}
                  </p>
                  <p class="text-sm">{accountRequest.comment}</p>
                </NoticeCard>
              )}

              <p class="text-xs text-dimmed">{t.requestCompletesOnCreate}</p>
            </div>
          )}
          <div class="rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-muted)] p-6">
            <div class="mb-6 flex flex-col gap-2">
              <h1 class="text-xl font-bold text-primary">{t.createNewAccount}</h1>
              <p class="text-sm text-dimmed">{t.createPageDescription}</p>
            </div>
            <CreateUserForm
              autoOpen
              freeIpaEnabled={freeIpaEnabled}
              prefill={
                accountRequest
                  ? {
                      requestId: accountRequest.id,
                      email: accountRequest.email,
                      givenname: accountRequest.firstName,
                      sn: accountRequest.lastName,
                      displayName: accountRequest.displayName ?? undefined,
                      firstName: accountRequest.firstName,
                    }
                  : undefined
              }
            />
            <div class="mt-6">
              <CreateUserForm
                buttonLabel={t.openAccountCreation}
                freeIpaEnabled={freeIpaEnabled}
                prefill={
                  accountRequest
                    ? {
                        requestId: accountRequest.id,
                        email: accountRequest.email,
                        givenname: accountRequest.firstName,
                        sn: accountRequest.lastName,
                        displayName: accountRequest.displayName ?? undefined,
                        firstName: accountRequest.firstName,
                      }
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      </AccountsWorkspace>
    </Layout>
  );
});
