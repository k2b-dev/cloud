import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { type Action, Bar, Nav, type NavGroup, RecordHead, type TwoActions, Workspace } from "@k2b/ui/v2";
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

/**
 * The frame of the account pages on v2. The sidebar holds the account's areas and its activity (the phone menu lists
 * the same), so the open area is the current entry and never a title of its own. The head names the person, the
 * account's one "thing", small in one row, with the page's deeds at its end.
 */
export default function AccountWorkspace(props: {
  user: AccountUserView;
  place: AccountTab | "activity";
  /** The page's deeds at the end of the head. */
  actions?: JSX.Element;
  /** The page's main deed, floating on the phone; the same deed stands as the primary button in `actions`. */
  primary?: Action;
  children: JSX.Element;
}) {
  const t = useAccountMessages();
  const groups = (): NavGroup[] => [
    {
      items: (
        [
          { id: "profile", href: "/me", label: t().profile, icon: "user" },
          { id: "security", href: "/me/security", label: t().securityAndDevices, icon: "shield-lock" },
          { id: "access", href: "/me/access", label: t().accessAndGroups, icon: "users-group" },
          { id: "notifications", href: "/me/notifications", label: t().notifications, icon: "bell" },
        ] satisfies { id: AccountTab; href: string; label: string; icon: string }[]
      ).map((area) => ({ label: area.label, icon: area.icon, href: area.href, current: area.id === props.place })),
    },
    {
      items: [{ label: t().activity, icon: "activity", href: ACCOUNT_ACTIVITY_PATH, current: props.place === "activity" }],
    },
  ];
  return (
    <>
      {/* on the phone the sidebar is a menu, so its title names the open place */}
      <V2WorkspaceNavigation
        label={
          groups()
            .flatMap((group) => group.items)
            .find((item) => item.current)?.label ?? t().account
        }
        groups={groups()}
      />
      <Workspace
        sidebar={<Nav title={t().account} icon="user-circle" groups={groups()} />}
        sidebarLabel={t().accountSections}
        head={
          <>
            <Bar
              start={
                <RecordHead
                  name={props.user.name}
                  avatar={{ name: props.user.name, image: props.user.image }}
                  kinds={props.user.kinds}
                  ids={[{ label: t().username, value: props.user.uid, copy: true }]}
                />
              }
              end={props.actions}
            />
          </>
        }
        primary={props.primary}
      >
        {props.children}
      </Workspace>
    </>
  );
}
