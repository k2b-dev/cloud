import type { NotificationQuietSettings, UserNotificationPreferencesResponse } from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import { Pane } from "@k2b/ui/v2";
import AccountWorkspace, { useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import BrowserNotificationsSection from "./BrowserNotificationsSection";
import NotificationPreferencesSections, { type NotificationAppMeta } from "./NotificationPreferencesSections";
import NotificationTabs from "./NotificationTabs";
import QuietTimeSection from "./QuietTimeSection";

/** `/me/notifications` on v2: this browser's push notifications, do not disturb, and what each app may send where. */
export default function NotificationsScreen(props: {
  user: AccountUserView;
  appTab: boolean;
  preferences: UserNotificationPreferencesResponse;
  apps: NotificationAppMeta[];
  quiet: NotificationQuietSettings;
  dateConfig: DateContext;
}) {
  const t = useAccountMessages();
  return (
    <AccountWorkspace user={props.user} active="notifications" appTab={props.appTab}>
      <Pane label={t().notifications} head={<NotificationTabs active="preferences" />}>
        <BrowserNotificationsSection />
        <QuietTimeSection initial={props.quiet} dateConfig={props.dateConfig} />
        <NotificationPreferencesSections initial={props.preferences} apps={props.apps} />
      </Pane>
    </AccountWorkspace>
  );
}
