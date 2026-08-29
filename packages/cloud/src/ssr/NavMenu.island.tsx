import { Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import type { Role } from "../contracts/shared";
import { platformMessages } from "./platform-messages";

/**
 * Minimal user projection for the nav menu — covers exactly what's rendered
 * (initials, display name, uid, profile flag, admin role check). Avoids
 * serializing the full `User` (incl. mail, ssh keys, phone, address, group
 * memberships) into HTML `data-props` on every authenticated page.
 */
export type NavMenuUser = {
  id: string;
  uid: string;
  displayName: string;
  profile: string;
  roles: Role[];
  avatarHash: string | null;
};

type NavMenuProps = {
  user?: NavMenuUser;
};

/** Navigation dropdown menu - always visible, adapts to auth state. */
export default function NavMenu(props: NavMenuProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const avatarName = () => props.user?.displayName || props.user?.uid || "?";
  const avatarSrc = () =>
    props.user?.id && props.user.avatarHash
      ? `/api/accounts/users/${encodeURIComponent(props.user.id)}/avatar?rev=${encodeURIComponent(props.user.avatarHash)}`
      : undefined;

  const getItems = (): DropdownItem[] => [
    ...(props.user
      ? [
          {
            href: "/me",
            icon: avatarSrc() ? undefined : "ti ti-user",
            image: avatarSrc(),
            label: avatarName(),
            description: props.user.displayName && props.user.profile !== "guest" ? props.user.uid : undefined,
          },
        ]
      : [
          {
            icon: "ti ti-login",
            label: t().signIn,
            href: "/auth/login",
          },
        ]),
  ];

  return (
    <Dropdown.Root position="bottom-left" width="16rem" items={getItems()}>
      <Dropdown.Trigger iconOnly label={t().menu}>
        <i class="ti ti-menu-2 text-lg" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
