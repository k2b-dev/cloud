import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { ButtonLink, DataTable, Dropdown, Format, Placeholder, StatusBadge } from "@k2b/ui";
import type { ArchiveEntry } from "../contracts";
import { type AdminLocation, adminHref } from "./admin-location";
import { useAdminMessages } from "./admin-messages";
import { useFilesMessages } from "./messages";
export default function ArchiveTable(props: {
  items: ArchiveEntry[];
  location: AdminLocation;
  busy: boolean;
  onAction: (action: "restore" | "delete" | "retry", entry: ArchiveEntry) => void;
  onNavigate: (event: LinkNavigateEvent) => Promise<void>;
}) {
  const t = useFilesMessages();
  const a = useAdminMessages();
  return (
    <DataTable<ArchiveEntry>
      surface="plain"
      density="compact"
      ariaLabel={a().archives}
      rows={props.items}
      columns={[
        { id: "name", header: t().name },
        { id: "origin", header: a().originalPath },
        { id: "date", header: a().archivedAt },
        { id: "status", header: t().status },
        { id: "actions", header: t().actions, align: "right" },
      ]}
      getRowId={(row) => row.id}
      empty={<Placeholder description={a().emptyArchive} />}
      renderCell={({ row, col }) => {
        if (col.id === "name")
          return row.state === "pending" ? (
            row.name
          ) : (
            <ButtonLink
              size="sm"
              variant="text"
              href={adminHref(props.location, { archiveId: row.id, path: "", after: undefined })}
              navigation="enhanced"
              onNavigate={props.onNavigate}
            >
              {row.name}
            </ButtonLink>
          );
        if (col.id === "origin") return <code class="text-xs break-all">{row.originalPath}</code>;
        if (col.id === "date") return <Format.DateTime value={row.createdAt} />;
        if (col.id === "status")
          return (
            <StatusBadge
              tone={row.state === "pending" ? "running" : "neutral"}
              label={row.state === "pending" ? a().pending : a().archives}
            />
          );
        return (
          <Dropdown.Root
            disabled={props.busy || !(row.canRestore || row.canDelete || row.canRetry)}
            items={[
              ...(row.canRetry && row.operationId
                ? [{ label: a().retry, icon: "ti ti-refresh", action: () => props.onAction("retry", row) }]
                : []),
              ...(row.canRestore ? [{ label: a().restore, icon: "ti ti-restore", action: () => props.onAction("restore", row) }] : []),
              ...(row.canDelete
                ? [{ label: a().delete, icon: "ti ti-trash", variant: "danger" as const, action: () => props.onAction("delete", row) }]
                : []),
            ]}
          >
            <Dropdown.Trigger iconOnly size="sm" label={`${t().actions}: ${row.name}`}>
              <i class="ti ti-dots-vertical" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        );
      }}
    />
  );
}
