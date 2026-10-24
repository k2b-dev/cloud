import type { PwaDeviceView } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Paper, Placeholder } from "@k2b/ui";
import { accountsMessages } from "../../messages";
import PairCloudApp from "./PairCloudApp.island";
import RemoveAppDevice from "./RemoveAppDevice.island";

type Props = {
  userId: string;
  name: string;
  /** The signed-in administrator, as the person's device will name them. */
  administrator: string;
  cloud: string;
  blocked: boolean;
  /** Null when the phones could not be loaded. */
  devices: PwaDeviceView[] | null;
  locale: string;
};

/** The installed Cloud app, kept separate from Cloud Login. */
export default function AppDevicesSection(props: Props) {
  const { locale, t } = accountsMessages.resolve([props.locale]);
  const platform = (value: PwaDeviceView["platform"]) =>
    value === "ios" ? t.platformIos : value === "android" ? t.platformAndroid : t.platformOther;
  const columns: DataTableColumn<PwaDeviceView>[] = [
    { id: "device", header: t.device, value: (device) => device.name, cellClass: "min-w-[14rem]" },
    { id: "platform", header: t.platform, value: (device) => platform(device.platform), cellClass: "whitespace-nowrap" },
    { id: "paired", header: t.pairedSince, value: (device) => device.createdAt, cellClass: "whitespace-nowrap" },
    { id: "lastUsed", header: t.lastUsed, value: (device) => device.lastUsedAt, cellClass: "whitespace-nowrap" },
    { id: "actions", header: t.actions, headerClass: "text-right", cellClass: "text-right whitespace-nowrap max-w-none" },
  ];

  return (
    <div class="flex flex-col gap-2" style="view-transition-name: accounts-user-app-devices">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-base font-semibold text-primary">{t.cloudApp}</h2>
          <p class="mt-1 text-xs text-dimmed">{t.cloudAppDescription({ cloud: props.cloud })}</p>
        </div>
        <PairCloudApp userId={props.userId} name={props.name} administrator={props.administrator} blocked={props.blocked} />
      </div>
      {props.devices === null ? (
        <Placeholder surface="paper" state="error" description={<>{t.appDevicesUnavailable}</>} />
      ) : props.devices.length === 0 ? (
        <Placeholder surface="paper" description={<>{t.cloudAppEmpty}</>} />
      ) : (
        <Paper class="overflow-hidden">
          <DataTable
            rows={props.devices}
            columns={columns}
            getRowId={(device) => device.id}
            hoverRows
            highlightColumns={false}
            class="overflow-x-auto"
            scrollPreserveKey="accounts-user-app-devices"
            renderCell={({ row: device, col }) => {
              if (col.id === "device") return <span class="block truncate font-medium text-primary">{device.name}</span>;
              if (col.id === "platform") return <span class="text-dimmed">{platform(device.platform)}</span>;
              if (col.id === "paired") return <span class="text-dimmed">{dates.formatDateTime(device.createdAt, { locale })}</span>;
              if (col.id === "lastUsed") return <span class="text-dimmed">{dates.formatDateTime(device.lastUsedAt, { locale })}</span>;
              if (col.id === "actions") return <RemoveAppDevice userId={props.userId} deviceId={device.id} name={device.name} />;
              return "";
            }}
          />
        </Paper>
      )}
    </div>
  );
}
