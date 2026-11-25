import { Tabs } from "@k2b/ui/v2";
import { useAccountMessages } from "./AccountWorkspace";

/** The two views of the notifications area, as the head of its pane. */
export default function NotificationTabs(props: { active: "preferences" | "history" }) {
  const t = useAccountMessages();
  return (
    <Tabs
      label={t().sectionViews}
      items={[
        { label: t().preferences, icon: "adjustments", href: "/me/notifications", current: props.active === "preferences" },
        { label: t().deliveryHistory, icon: "history", href: "/me/notifications/history", current: props.active === "history" },
      ]}
    />
  );
}
