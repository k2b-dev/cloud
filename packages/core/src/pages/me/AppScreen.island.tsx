import type { PwaDeviceView } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import { Button, Pane } from "@k2b/ui/v2";
import AccountWorkspace, { useAccountMessages } from "./AccountWorkspace";
import { useAppDevices } from "./AppDevicesSection";
import type { AccountUserView } from "./account-view";

/** `/me/app` on v2: the phones paired with the mobile app, pairing another one and removing one. */
export default function AppScreen(props: {
  user: AccountUserView;
  userId: string;
  devices: PwaDeviceView[];
  dateConfig: DateContext;
  description: string;
}) {
  const t = useAccountMessages();
  const devices = useAppDevices({ userId: props.userId, initial: props.devices, dateConfig: props.dateConfig, summary: props.description });
  return (
    <AccountWorkspace
      user={props.user}
      active="app"
      appTab
      actions={
        <Button variant="primary" icon="plus" onClick={devices.pair}>
          {t().pwaPair}
        </Button>
      }
      primary={{ label: t().pwaPair, icon: "plus", onClick: devices.pair }}
    >
      <Pane label={t().pwaTab}>{devices.section()}</Pane>
      {devices.dialog()}
    </AccountWorkspace>
  );
}
