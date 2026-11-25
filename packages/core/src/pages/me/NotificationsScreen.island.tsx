import type { NotificationQuietSettings, UserNotificationPreferencesResponse } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import { Pane } from "@k2b/ui/v2";
import AccountWorkspace, { AccountTabs, sideWidth, useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import BrowserNotificationsSection from "./BrowserNotificationsSection";
import NotificationPreferencesSections, { type NotificationAppMeta } from "./NotificationPreferencesSections";
import QuietTimeSection from "./QuietTimeSection";

/** `/me/notifications` on v2: what each app may send where; this browser's push notifications and do not disturb beside it. */
export default function NotificationsScreen(props: {
  user: AccountUserView;
  preferences: UserNotificationPreferencesResponse;
  apps: NotificationAppMeta[];
  quiet: NotificationQuietSettings;
  dateConfig: DateContext;
}) {
  const t = useAccountMessages();
  return (
    <AccountWorkspace user={props.user} place="account">
      <Pane label={t().notifications} head={<AccountTabs active="notifications" />}>
        <Pane.Split>
          <Pane label={t().notifications}>
            <NotificationPreferencesSections initial={props.preferences} apps={props.apps} />
          </Pane>
          <Pane side label={t().quietTitle} width={sideWidth}>
            <BrowserNotificationsSection />
            <QuietTimeSection initial={props.quiet} dateConfig={props.dateConfig} />
          </Pane>
        </Pane.Split>
      </Pane>
    </AccountWorkspace>
  );
}
