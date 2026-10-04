import type { PwaDeviceView } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Paper, Placeholder } from "@k2b/ui";
import { accountsMessages } from "../../messages";
import RemoveAppDevice from "./RemoveAppDevice.island";

type Props = {
  userId: string;
  /** Null when the phones could not be loaded. */
  devices: PwaDeviceView[] | null;
  locale: string;
};

/**
 * The person's phones in the mobile app. Renders nothing while there are none, so it stays absent until the app ships;
 * a failed load shows an error instead of hiding a phone an administrator may need to remove.
 */
export default function AppDevicesSection(props: Props) {
  const { locale, t } = accountsMessages.resolve([props.locale]);
  if (props.devices === null)
    return (
      <div class="flex flex-col gap-2" style="view-transition-name: accounts-user-app-devices">
        <h2 class="text-base font-semibold text-primary">{t.appDevices}</h2>
        <Placeholder surface="paper" state="error" description={<>{t.appDevicesUnavailable}</>} />
      </div>
    );
  if (props.devices.length === 0) return null;
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
      <div class="min-w-0">
        <h2 class="text-base font-semibold text-primary">{t.appDevices}</h2>
        <p class="mt-1 text-xs text-dimmed">{t.appDevicesSummary({ count: props.devices.length })}</p>
      </div>
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
    </div>
  );
}
