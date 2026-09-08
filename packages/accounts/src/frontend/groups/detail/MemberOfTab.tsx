import { DataTable, type DataTableColumn, Pagination, Paper, Placeholder, Tag } from "@k2b/ui";
import type { EntityListItem, PaginationResponse } from "@/contracts";

import { useAccountsMessages } from "../../messages";
import AddGroupToGroup from "./AddGroupToGroup.island";
import RemoveFromGroup from "./RemoveFromGroup.island";
import TabToolbar from "./TabToolbar";

type MemberOfTabProps = {
  groupId: string;
  groupProvider: "ipa" | "local";
  items: EntityListItem[];
  allParentGroupIds: string[];
  isAdmin: boolean;
  groupHref: (groupId: string) => string;
  pagination: PaginationResponse;
  pageBaseUrl: string;
};

export default function MemberOfTab(props: MemberOfTabProps) {
  const messages = useAccountsMessages();
  const hasGroups = props.items.length > 0;
  const columns: DataTableColumn<EntityListItem>[] = [
    { id: "group", header: messages().group, value: (item) => (item.kind === "group" ? item.group.name : "") },
    {
      id: "description",
      header: messages().description,
      value: (item) => (item.kind === "group" ? item.group.description : ""),
      cellClass: "max-w-[24rem]",
    },
    { id: "provider", header: messages().provider, value: (item) => (item.kind === "group" ? item.group.provider : "") },
    {
      id: "actions",
      header: messages().actions,
      headerClass: "text-right",
      cellClass: "w-10 text-right whitespace-nowrap max-w-none",
    },
  ];

  return (
    <div class="flex flex-col gap-2" style="view-transition-name: accounts-group-member-of">
      <TabToolbar
        actions={
          props.isAdmin ? (
            <AddGroupToGroup groupId={props.groupId} groupProvider={props.groupProvider} excludeGroups={props.allParentGroupIds} />
          ) : undefined
        }
      />

      {!hasGroups ? (
        <Placeholder surface="paper" icon="ti ti-users-group" description={<>{messages().noParentGroups}</>} />
      ) : (
        <Paper class="overflow-hidden">
          <DataTable
            rows={props.items}
            columns={columns}
            getRowId={(item) => (item.kind === "group" ? item.group.id : "unknown")}
            hoverRows
            density="compact"
            class="overflow-x-auto"
            scrollPreserveKey="accounts-group-member-of-table"
            renderCell={({ row: item, col }) => {
              if (item.kind !== "group") return "";
              const group = item.group;
              const href = props.groupHref(group.id);

              if (col.id === "group")
                return (
                  <a href={href} class="block truncate font-medium text-primary hover:underline">
                    {group.name}
                  </a>
                );
              if (col.id === "description") {
                return (
                  <a href={href} class="block truncate text-dimmed" tabindex={-1} title={group.description || messages().noDescription}>
                    {group.description || <span class="italic">{messages().noDescription}</span>}
                  </a>
                );
              }
              if (col.id === "provider") return <Tag>{group.provider === "ipa" ? "FreeIPA" : messages().local}</Tag>;
              if (col.id === "actions")
                return props.isAdmin ? (
                  <RemoveFromGroup groupId={props.groupId} parentGroupId={group.id} parentGroupName={group.name} />
                ) : null;
              return "";
            }}
          />
        </Paper>
      )}

      <Pagination currentPage={props.pagination.page} totalPages={props.pagination.total_pages} baseUrl={props.pageBaseUrl} />
    </div>
  );
}
