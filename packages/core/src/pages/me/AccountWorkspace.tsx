import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { type Action, Bar, Nav, type NavItem, RecordHead, Tabs, Text, type TwoActions, Workspace } from "@k2b/ui/v2";
import type { JSX } from "solid-js";
import type { AccountUserView } from "./account-view";
import { accountMessages } from "./messages";
import { ACCOUNT_ACTIVITY_PATH } from "./paths";

/** The areas of the account record, each with its own address. */
export type AccountTab = "profile" | "security" | "access" | "notifications";

/** The side column of the account record keeps one width on every tab. */
export const sideWidth = { min: 300, default: 360 };

/** The account's messages in the page's locale. */
export const useAccountMessages = () => {
  const locale = useLocale();
  return () => accountMessages.resolve([locale()]).t;
};

/** At most two deeds for a section head, from the ones this person may take. */
export const twoActions = (list: readonly Action[]): TwoActions | undefined => {
  const [first, second] = list;
  return first ? (second ? [first, second] : [first]) : undefined;
};

/** The areas of the account record as the head of its pane. */
export function AccountTabs(props: { active: AccountTab }) {
  const t = useAccountMessages();
  return (
    <Tabs
      label={t().accountSections}
      items={(
        [
          { id: "profile", href: "/me", label: t().profile, icon: "user" },
          { id: "security", href: "/me/security", label: t().securityAndDevices, icon: "shield-lock" },
          { id: "access", href: "/me/access", label: t().accessAndGroups, icon: "users-group" },
          { id: "notifications", href: "/me/notifications", label: t().notifications, icon: "bell" },
        ] satisfies { id: AccountTab; href: string; label: string; icon: string }[]
      ).map((tab) => ({ label: tab.label, icon: tab.icon, href: tab.href, current: tab.id === props.active }))}
    />
  );
}

/**
 * The frame of the account pages on v2: the account and its activity in the sidebar (the phone menu lists the same).
 * The account record names the person in the head; the activity names itself. The head's end holds the page's deeds.
 */
export default function AccountWorkspace(props: {
  user: AccountUserView;
  place: "account" | "activity";
  /** The page's deeds at the end of the head. */
  actions?: JSX.Element;
  /** The page's main deed, floating on the phone; the same deed stands as the primary button in `actions`. */
  primary?: Action;
  children: JSX.Element;
}) {
  const t = useAccountMessages();
  const groups = (): { items: NavItem[] }[] => [
    {
      items: [
        { label: t().account, icon: "user-circle", href: "/me", current: props.place === "account" },
        { label: t().activity, icon: "activity", href: ACCOUNT_ACTIVITY_PATH, current: props.place === "activity" },
      ],
    },
  ];
  return (
    <>
      <V2WorkspaceNavigation label={t().account} groups={groups()} />
      <Workspace
        sidebar={<Nav title={t().account} icon="user-circle" groups={groups()} />}
        sidebarLabel={t().accountSections}
        head={
          <Bar
            start={
              props.place === "account" ? (
                <RecordHead
                  name={props.user.name}
                  avatar={{ name: props.user.name, image: props.user.image }}
                  kinds={props.user.kinds}
                  ids={[{ label: t().username, value: props.user.uid, copy: true }]}
                />
              ) : (
                <Text type="body" weight="strong">
                  {t().activity}
                </Text>
              )
            }
            end={props.actions}
          />
        }
        primary={props.primary}
      >
        {props.children}
      </Workspace>
    </>
  );
}
