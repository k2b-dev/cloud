import { DataTable, type DataTableColumn, Pagination, Placeholder } from "@k2b/ui";
import type { EntityListItem, PaginationResponse } from "@/contracts";
import AccountAvatar from "@/frontend/AccountAvatar";
import { getPrimaryAccountBadge, getProviderBadge } from "../../lib/account-badges";
import { useAccountsMessages } from "../../messages";
import AddMember from "./AddMember.island";
import RemoveMember from "./RemoveMember.island";
import TabToolbar from "./TabToolbar";

type ManagersTabProps = {
  items: EntityListItem[];
  pagination: PaginationResponse;
  groupId: string;
  groupProvider: "ipa" | "local";
  allManagerIds: string[];
  allManagerGroupIds: string[];
  canManage: boolean;
  isAdmin: boolean;
  groupHref: (groupId: string) => string;
  pageBaseUrl: string;
  serviceAccountsToggleUrl: string;
  showServiceAccounts: boolean;
};

export default function ManagersTab(props: ManagersTabProps) {
  const messages = useAccountsMessages();
  const isEmpty = props.items.length === 0;
  const columns: DataTableColumn<EntityListItem>[] = [
    { id: "type", header: messages().type, value: (item) => item.kind, cellClass: "whitespace-nowrap" },
    {
      id: "name",
      header: messages().name,
      value: (item) =>
        item.kind === "user"
          ? item.user.displayName || item.user.mail || item.user.uid
          : item.kind === "group"
            ? item.group.name
            : item.serviceAccount.name,
    },
    {
      id: "detail",
      header: messages().detail,
      value: (item) => (item.kind === "user" ? item.user.mail : item.kind === "group" ? item.group.description : item.serviceAccount.appId),
      cellClass: "max-w-[24rem]",
    },
    { id: "access", header: messages().access },
    {
      id: "actions",
      header: messages().actions,
      headerClass: "text-right",
      cellClass: "w-10 text-right whitespace-nowrap max-w-none",
    },
  ];
  const rowId = (item: EntityListItem) =>
    item.kind === "user"
      ? `user:${item.user.id}`
      : item.kind === "group"
        ? `group:${item.group.id}`
        : `service_account:${item.serviceAccount.id}`;

  return (
    <div class="flex flex-col gap-2" style="view-transition-name: accounts-group-managers">
      <TabToolbar
        serviceAccountsToggleUrl={props.serviceAccountsToggleUrl}
        showServiceAccounts={props.showServiceAccounts}
        actions={
          props.canManage ? (
            <AddMember
              groupId={props.groupId}
              groupProvider={props.groupProvider}
              membershipRole="managers"
              searchUsers={true}
              searchGroups={props.isAdmin}
              excludeUserIds={props.allManagerIds}
              excludeGroups={props.allManagerGroupIds}
            />
          ) : undefined
        }
      />

      {isEmpty ? (
        <Placeholder surface="paper" icon="ti ti-users-group" description={<>{messages().noManagers}</>} />
      ) : (
        <div class="paper overflow-hidden">
          <DataTable
            rows={props.items}
            columns={columns}
            getRowId={rowId}
            hoverRows
            density="compact"
            class="overflow-x-auto"
            scrollPreserveKey="accounts-group-managers-table"
            renderCell={({ row: item, col }) => {
              if (item.kind === "user") {
                const user = item.user;
                const accessBadge = getPrimaryAccountBadge(user);
                const href = props.isAdmin ? `/app/accounts/users/${user.id}` : undefined;
                if (col.id === "type") return <span class="text-dimmed">{messages().user}</span>;
                if (col.id === "name") {
                  const label = `${user.displayName || user.mail || user.uid} (${user.uid})`;
                  const content = (
                    <>
                      <AccountAvatar
                        name={user.displayName || user.mail || user.uid}
                        userId={user.id}
                        avatarHash={user.avatarHash}
                        size="xs"
                      />
                      <span class="truncate font-medium">{label}</span>
                    </>
                  );
                  return href ? (
                    <a href={href} class="flex min-w-0 items-center gap-2 text-primary hover:underline">
                      {content}
                    </a>
                  ) : (
                    <span class="flex min-w-0 items-center gap-2 text-primary">{content}</span>
                  );
                }
                if (col.id === "detail") {
                  const value = user.mail || "-";
                  return href ? (
                    <a href={href} class="block truncate text-dimmed" tabindex={-1} title={value}>
                      {value}
                    </a>
                  ) : (
                    <span class="truncate text-dimmed" title={value}>
                      {value}
                    </span>
                  );
                }
                if (col.id === "access")
                  return (
                    <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${accessBadge.className}`}>
                      {user.profile === "user" ? messages().fullAccount : messages().guestAccount}
                    </span>
                  );
                if (col.id === "actions") {
                  return props.canManage ? (
                    <RemoveMember
                      groupId={props.groupId}
                      membershipRole="managers"
                      type="user"
                      id={user.id}
                      label={user.displayName || user.uid}
                    />
                  ) : null;
                }
                return "";
              }

              if (item.kind === "service_account") {
                const serviceAccount = item.serviceAccount;
                const kindLabel = serviceAccount.kind === "user_delegated" ? messages().userBound : messages().resourceBound;
                const href = props.isAdmin ? `/app/accounts/service-accounts?search=${encodeURIComponent(serviceAccount.name)}` : undefined;
                if (col.id === "type") return <span class="text-dimmed">{messages().serviceAccount}</span>;
                if (col.id === "name") {
                  const content = (
                    <>
                      <span class="flex size-6 shrink-0 items-center justify-center rounded bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        <i class="ti ti-user-key text-sm" aria-hidden="true" />
                      </span>
                      <span class="truncate font-medium">{serviceAccount.name}</span>
                    </>
                  );
                  return href ? (
                    <a href={href} class="flex min-h-8 min-w-0 items-center gap-2 text-primary hover:underline">
                      {content}
                    </a>
                  ) : (
                    <span class="flex min-h-8 min-w-0 items-center gap-2 text-primary">{content}</span>
                  );
                }
                if (col.id === "detail") {
                  const content = (
                    <span class="block truncate" title={serviceAccount.appId || messages().noAppId}>
                      {serviceAccount.appId || <span class="italic">{messages().noAppId}</span>}
                    </span>
                  );
                  return href ? (
                    <a href={href} class="block truncate text-dimmed" tabindex={-1}>
                      {content}
                    </a>
                  ) : (
                    <span class="text-dimmed">{content}</span>
                  );
                }
                if (col.id === "access")
                  return (
                    <span class="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                      {kindLabel}
                    </span>
                  );
                return null;
              }

              const group = item.group;
              const providerBadge = getProviderBadge(group.provider);
              const href = props.groupHref(group.id);
              if (col.id === "type") return <span class="text-dimmed">{messages().group}</span>;
              if (col.id === "name")
                return (
                  <a href={href} class="block truncate font-medium text-primary hover:underline">
                    {group.name}
                  </a>
                );
              if (col.id === "detail") {
                return (
                  <a href={href} class="block truncate text-dimmed" tabindex={-1} title={group.description || messages().noDescription}>
                    {group.description || <span class="italic">{messages().noDescription}</span>}
                  </a>
                );
              }
              if (col.id === "access")
                return (
                  <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${providerBadge.className}`}>
                    {group.provider === "ipa" ? "FreeIPA" : messages().local}
                  </span>
                );
              if (col.id === "actions")
                return props.canManage ? (
                  <RemoveMember groupId={props.groupId} membershipRole="managers" type="group" id={group.id} label={group.name} />
                ) : null;
              return "";
            }}
          />
        </div>
      )}

      <Pagination currentPage={props.pagination.page} totalPages={props.pagination.total_pages} baseUrl={props.pageBaseUrl} />
    </div>
  );
}
