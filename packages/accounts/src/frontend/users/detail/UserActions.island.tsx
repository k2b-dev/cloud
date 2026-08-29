import { Dropdown, type DropdownItem } from "@k2b/ui";
import type { User } from "@/contracts";
import { useAccountsMessages } from "../../messages";
import { createUserActions } from "./user-actions/use-user-actions";

type UserActionsProps = {
  user: User;
  listHref: string;
  freeIpaEnabled: boolean;
};

export default function UserActions(props: UserActionsProps) {
  const messages = useAccountsMessages();
  const actions = createUserActions(props);
  const accessItems: Extract<DropdownItem, { items: unknown }>["items"] = [
    ...(actions.isIpaUser && props.freeIpaEnabled
      ? [
          {
            icon: "ti ti-home-move",
            label: messages().makeLocal,
            action: actions.handleMakeLocal,
          },
          {
            icon: "ti ti-lock-open",
            label: messages().resetPassword,
            action: actions.handleResetPassword,
            variant: "danger" as const,
          },
        ]
      : []),
    ...(actions.isLocalUser
      ? [
          ...(actions.canCreateLoginToken
            ? [
                {
                  icon: "ti ti-key",
                  label: messages().loginToken,
                  action: actions.handleCreateLoginToken,
                },
              ]
            : []),
          {
            icon: actions.isGuestProfile ? "ti ti-user-up" : "ti ti-user-down",
            label: actions.isGuestProfile ? messages().promote : messages().demote,
            action: () => actions.handleSetProfile(actions.isGuestProfile ? "user" : "guest"),
          },
          ...(actions.isGuestProfile
            ? []
            : [
                {
                  icon: actions.isLocalAdmin ? "ti ti-shield-x" : "ti ti-shield-check",
                  label: actions.isLocalAdmin ? messages().revokeAdmin : messages().grantAdmin,
                  action: () => actions.handleSetAdmin(!actions.isLocalAdmin),
                },
              ]),
        ]
      : []),
    ...(actions.canCreateIpa
      ? [
          {
            icon: "ti ti-building-fortress",
            label: messages().createFreeIpa,
            action: actions.handleCreateIpa,
          },
        ]
      : []),
  ];

  const menuElements: DropdownItem[] = [
    {
      sectionLabel: messages().auditLog,
      items: [
        {
          icon: "ti ti-clipboard-list",
          label: messages().actionsByUser,
          href: actions.auditByUserHref,
        },
        {
          icon: "ti ti-user-search",
          label: messages().actionsOnUser,
          href: actions.auditOnUserHref,
        },
      ],
    },
    {
      sectionLabel: messages().account,
      items: [
        {
          icon: "ti ti-camera",
          label: messages().changeAvatar,
          action: actions.handleChangeAvatar,
        },
        ...(actions.canMutateUser
          ? [
              {
                icon: "ti ti-pencil",
                label: messages().edit,
                action: actions.handleEdit,
              },
            ]
          : []),
        {
          icon: "ti ti-send",
          label: messages().notify,
          action: actions.handleNotify,
        },
        ...(actions.canSetExpiry
          ? [
              {
                icon: "ti ti-calendar",
                label: messages().setExpiry,
                action: actions.handleSetExpiry,
              },
            ]
          : []),
      ],
    },
    ...(accessItems.length
      ? [
          {
            sectionLabel: messages().access,
            items: accessItems,
          },
        ]
      : []),
    ...(actions.canMutateUser
      ? [
          {
            sectionLabel: messages().dangerZone,
            items: [
              {
                icon: "ti ti-trash",
                label: messages().delete,
                action: actions.handleDestroy,
                variant: "danger" as const,
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <Dropdown.Root position="bottom-left" width="14rem" items={menuElements}>
      <Dropdown.Trigger size="sm" variant="subtle" aria-label={messages().userActions}>
        <i class="ti ti-dots-vertical text-sm" />
        {messages().actions}
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
