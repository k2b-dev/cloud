import { DataTable, type DataTableColumn, Placeholder, useLocale } from "@k2b/ui";
import type { IpaHost } from "@/contracts";
import CopyButton from "./CopyButton.island";
import EditHost from "./EditHost.island";
import { hostMessages } from "./messages";

type Props = {
  hosts: IpaHost[];
  currentGroup?: string;
  emptyMessage?: string;
};

const HostsTable = (props: Props) => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const columns: DataTableColumn<IpaHost>[] = [
    { id: "fqdn", header: "FQDN", value: (host) => host.fqdn },
    { id: "description", header: t().description, value: (host) => host.description, cellClass: "max-w-[220px]" },
    {
      id: "location",
      header: t().location,
      value: (host) => [host.locality, host.location].filter(Boolean).join(" · "),
      cellClass: "whitespace-nowrap",
    },
    { id: "mac", header: "MAC", value: (host) => host.macAddress },
    {
      id: "actions",
      header: <span class="sr-only">{t().actions}</span>,
      headerClass: "w-px text-right",
      cellClass: "text-right whitespace-nowrap max-w-none",
    },
  ];

  return props.hosts.length > 0 ? (
    <DataTable
      rows={props.hosts}
      columns={columns}
      getRowId={(host) => host.fqdn}
      hoverRows
      class="overflow-x-auto"
      renderCell={({ row: host, col }) => {
        if (col.id === "fqdn") {
          return (
            <div class="flex items-center gap-1.5">
              <span class="max-w-[260px] truncate font-medium text-primary">{host.fqdn}</span>
              <CopyButton text={host.fqdn} size="xs" class="shrink-0" />
            </div>
          );
        }
        if (col.id === "description") return <span class="text-dimmed">{host.description || "-"}</span>;
        if (col.id === "location") {
          return <span class="text-dimmed">{[host.locality, host.location].filter(Boolean).join(" · ") || "-"}</span>;
        }
        if (col.id === "mac") {
          return host.macAddress.length > 0 ? (
            <div class="flex flex-col gap-0.5">
              {host.macAddress.map((mac) => (
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-mono text-dimmed">{mac}</span>
                  <CopyButton text={mac} size="xs" class="shrink-0" />
                </div>
              ))}
            </div>
          ) : (
            <span class="text-xs text-dimmed">-</span>
          );
        }
        if (col.id === "actions") {
          return (
            <EditHost
              fqdn={host.fqdn}
              description={host.description}
              locality={host.locality}
              location={host.location}
              macAddress={host.macAddress}
              memberofHostgroup={host.memberofHostgroup}
              currentGroup={props.currentGroup}
            />
          );
        }
        return "";
      }}
    />
  ) : (
    <Placeholder description={<>{props.emptyMessage ?? t().noHosts}</>} />
  );
};

export default HostsTable;
