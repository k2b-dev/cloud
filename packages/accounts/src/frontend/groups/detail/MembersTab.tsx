import { DataTable, type DataTableColumn, Pagination, Placeholder } from "@k2b/ui";
import type { EntityListItem, PaginationResponse } from "@/contracts";
import AccountAvatar from "@/frontend/AccountAvatar";
import { getPrimaryAccountBadge, getProviderBadge } from "../../lib/account-badges";
import { useAccountsMessages } from "../../messages";
import AddMember from "./AddMember.island";
import RemoveMember from "./RemoveMember.island";
import TabToolbar from "./TabToolbar";

type MembersTabProps = {
  items: EntityListItem[];
  pagination: PaginationResponse;
  search: string;
  groupId: string;
  groupProvider: "ipa" | "local";
  allMemberIds: string[];
  allMemberGroupIds: string[];
  isAdmin: boolean;
  canManage: boolean;
  indirect: boolean;
  groupHref: (groupId: string) => string;
  pageBaseUrl: string;
  toggleIndirectUrl: string;
  serviceAccountsToggleUrl: string;
  showServiceAccounts: boolean;
};

export default function MembersTab(props: MembersTabProps) {
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
    { id: "membership", header: messages().membershipDirectness },
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
    <div class="flex flex-col gap-2" style="view-transition-name: accounts-group-members">
      <TabToolbar
        indirectToggleUrl={props.toggleIndirectUrl}
        indirect={props.indirect}
        serviceAccountsToggleUrl={props.serviceAccountsToggleUrl}
        showServiceAccounts={props.showServiceAccounts}
        actions={
          props.canManage ? (
            <AddMember
              groupId={props.groupId}
              groupProvider={props.groupProvider}
              membershipRole="members"
              searchUsers={true}
              searchGroups={props.isAdmin}
              excludeUserIds={props.allMemberIds}
              excludeGroups={props.allMemberGroupIds}
            />
          ) : undefined
        }
      />

      {props.indirect && <p class="text-xs text-dimmed">{messages().allMembersIncludingIndirect}</p>}

      {isEmpty ? (
        <Placeholder
          surface="paper"
          icon="ti ti-users"
          description={<>{props.search ? messages().noMatchingMembers : messages().noMembers}</>}
        />
      ) : (
        <div class="paper overflow-hidden">
          <DataTable
            rows={props.items}
            columns={columns}
            getRowId={rowId}
            hoverRows
            density="compact"
            class="overflow-x-auto"
            scrollPreserveKey="accounts-group-members-table"
            renderCell={({ row: item, col }) => {
              const isIndirect = item.relation?.direct === false;
              const membershipClass = isIndirect
                ? "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"
                : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200";
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
                if (col.id === "membership")
                  return (
                    <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${membershipClass}`}>
                      {isIndirect ? messages().indirect : messages().direct}
                    </span>
                  );
                if (col.id === "actions") {
                  return props.canManage && !isIndirect ? (
                    <RemoveMember
                      groupId={props.groupId}
                      membershipRole="members"
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
                if (col.id === "membership")
                  return (
                    <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${membershipClass}`}>
                      {isIndirect ? messages().indirect : messages().direct}
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
              if (col.id === "membership")
                return (
                  <span class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${membershipClass}`}>
                    {isIndirect ? messages().indirect : messages().direct}
                  </span>
                );
              if (col.id === "actions") {
                return props.canManage && !isIndirect ? (
                  <RemoveMember groupId={props.groupId} membershipRole="members" type="group" id={group.id} label={group.name} />
                ) : null;
              }
              return "";
            }}
          />
        </div>
      )}

      <Pagination currentPage={props.pagination.page} totalPages={props.pagination.total_pages} baseUrl={props.pageBaseUrl} />
    </div>
  );
}
