import { APPROVALS_PAGE_PATH } from "@k2b/cloud/contracts/approvals";
import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { type Action, Bar, Nav, type NavItem, RecordHead, type TwoActions, Workspace } from "@k2b/ui/v2";
import type { JSX } from "solid-js";
import type { AccountUserView } from "./account-view";
import { accountMessages } from "./messages";

export type AccountSection = "profile" | "security" | "access" | "notifications" | "approvals" | "developer" | "app";

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
 * The frame of every account page on v2: the account's sections in the sidebar (the phone menu lists the same), the
 * person in the head, and the page's one column below. The head's end holds the page's deed, if it has one.
 */
export default function AccountWorkspace(props: {
  user: AccountUserView;
  active: AccountSection;
  /** Shows the App section while the installation offers the mobile app. */
  appTab?: boolean;
  /** The page's deeds at the end of the head. */
  actions?: JSX.Element;
  /** The page's main deed, floating on the phone; the same deed stands as the primary button in `actions`. */
  primary?: Action;
  children: JSX.Element;
}) {
  const t = useAccountMessages();
  const items = (): NavItem[] =>
    (
      [
        { id: "profile", href: "/me", label: t().profile, icon: "user" },
        { id: "security", href: "/me/security", label: t().security, icon: "shield-lock" },
        { id: "access", href: "/me/access", label: t().access, icon: "users-group" },
        { id: "notifications", href: "/me/notifications", label: t().notifications, icon: "bell" },
        { id: "approvals", href: APPROVALS_PAGE_PATH, label: t().approvals, icon: "shield-check" },
        { id: "developer", href: "/me/developer", label: t().developer, icon: "terminal-2" },
        ...(props.appTab ? [{ id: "app" as const, href: "/me/app", label: t().pwaTab, icon: "device-mobile" }] : []),
      ] satisfies { id: AccountSection; href: string; label: string; icon: string }[]
    ).map((section) => ({
      label: section.label,
      icon: section.icon,
      href: section.href,
      current: section.id === props.active,
    }));
  const groups = () => [{ items: items() }];
  return (
    <>
      <V2WorkspaceNavigation label={t().account} groups={groups()} />
      <Workspace
        sidebar={<Nav title={t().account} icon="user-circle" groups={groups()} />}
        sidebarLabel={t().accountSections}
        head={
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
        }
        primary={props.primary}
      >
        {props.children}
      </Workspace>
    </>
  );
}
