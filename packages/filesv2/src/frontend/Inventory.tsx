import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { Button, ButtonLink, DataTable, Dropdown, type DropdownItem, Placeholder } from "@k2b/ui";
import { Show } from "solid-js";
import type { InventoryEntry } from "../contracts";
import { type AdminLocation, adminHref } from "./admin-location";
import { useAdminMessages } from "./admin-messages";
import { DirectoryStatus } from "./feedback";
import { useFilesMessages } from "./messages";
export type DirectoryAction = "details" | "create" | "adopt" | "archive" | "delete" | "retire" | "retry";
export default function Inventory(props: {
  items: InventoryEntry[];
  location: AdminLocation;
  busy: boolean;
  onAction: (action: DirectoryAction, entry: InventoryEntry) => void;
  onNavigate: (event: LinkNavigateEvent) => Promise<void>;
}) {
  const t = useFilesMessages();
  const a = useAdminMessages();
  const actions = (row: InventoryEntry): DropdownItem[] => [
    { label: a().details, icon: "ti ti-info-circle", action: () => props.onAction("details", row) },
    ...(row.operationId ? [{ label: a().retry, icon: "ti ti-refresh", action: () => props.onAction("retry", row) }] : []),
    ...(["create", "adopt", "archive", "retire", "delete"] as const)
      .filter((action) => row.actions[action] && !(action === "create" && row.status === "missing"))
      .map((action) => ({
        label: action === "adopt" ? t().adopt : action === "retire" ? a().retire : a()[action],
        icon: action === "delete" ? "ti ti-trash" : "ti ti-folder",
        variant: action === "delete" ? ("danger" as const) : undefined,
        action: () => props.onAction(action, row),
      })),
  ];
  return (
    <DataTable<InventoryEntry>
      surface="plain"
      density="compact"
      ariaLabel={a().directories}
      rows={props.items}
      columns={[
        { id: "name", header: t().name },
        { id: "status", header: t().status },
        { id: "path", header: t().path },
        { id: "actions", header: t().actions, align: "right" },
      ]}
      getRowId={(row) => `${row.identityId ?? "directory"}:${row.path}`}
      empty={<Placeholder description={a().noEntries} />}
      renderCell={({ row, col }) => {
        if (col.id === "name")
          return row.actions.browse ? (
            <ButtonLink
              size="sm"
              variant="text"
              navigation="enhanced"
              onNavigate={props.onNavigate}
              href={adminHref(props.location, { name: row.name, path: "", after: undefined })}
            >
              {row.name}
            </ButtonLink>
          ) : (
            row.name
          );
        if (col.id === "status") return <DirectoryStatus status={row.status} />;
        if (col.id === "path") return <code class="break-all text-xs">{row.path}</code>;
        return (
          <div class="flex items-center justify-end gap-1">
            <Show when={row.status === "missing" && row.actions.create}>
              <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onAction("create", row)}>
                {a().create}
              </Button>
            </Show>
            <Dropdown.Root disabled={props.busy} items={actions(row)}>
              <Dropdown.Trigger iconOnly size="sm" label={`${t().actions}: ${row.name}`}>
                <i class="ti ti-dots-vertical" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </div>
        );
      }}
    />
  );
}
