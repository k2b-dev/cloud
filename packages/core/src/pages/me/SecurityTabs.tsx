import { Tabs } from "@k2b/ui/v2";
import { useAccountMessages } from "./AccountWorkspace";
import { ACTIVITY_PAGE_PATH } from "./activity-query";

/** The two views of the security area, as the head of its pane. */
export default function SecurityTabs(props: { active: "sign-in" | "activity" }) {
  const t = useAccountMessages();
  return (
    <Tabs
      label={t().sectionViews}
      items={[
        { label: t().security, icon: "shield-lock", href: "/me/security", current: props.active === "sign-in" },
        { label: t().accountActivity, icon: "activity", href: ACTIVITY_PAGE_PATH, current: props.active === "activity" },
      ]}
    />
  );
}
