import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, RemoveButton } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { showAccountActionNotice } from "../../action-notice";
import { useAccountsMessages } from "../../messages";

type RemoveMemberProps = {
  /** Group ID */
  groupId: string;
  /** "members" or "managers" */
  membershipRole: "members" | "managers";
  /** Type of entity to remove */
  type: "user" | "group";
  /** UID or CN of the entity */
  id: string;
  /** Display label for the confirmation */
  label: string;
};

export default function RemoveMember(props: RemoveMemberProps) {
  const messages = useAccountsMessages();
  const mutation = mutations.create<void, void>({
    mutation: async () => {
      const endpoint =
        props.membershipRole === "members" ? apiClient.groups[":id"].members.$delete : apiClient.groups[":id"].managers.$delete;
      const res = await endpoint({
        param: { id: props.groupId },
        json: { type: props.type, id: props.id },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? messages().removeFailed);
      }
      await showAccountActionNotice(
        {
          action: props.membershipRole === "members" ? "group.member.remove" : "group.manager.remove",
          id: props.groupId,
          relatedId: props.id,
        },
        messages(),
      );
    },
    onSuccess: () => {
      refreshCurrentPath();
    },
    onError: (err) => {
      prompts.error(err.message);
    },
  });

  const handleClick = async () => {
    const confirmed = await prompts.confirm(
      props.membershipRole === "members"
        ? messages().removeMemberConfirm({ name: props.label })
        : messages().removeManagerConfirm({ name: props.label }),
      {
        title: props.membershipRole === "members" ? messages().removeMember : messages().removeManager,
        icon: "ti ti-user-minus",
        confirmText: messages().remove,
        cancelText: messages().cancel,
        variant: "danger",
      },
    );

    if (confirmed) {
      await mutation.mutate();
    }
  };

  return <RemoveButton ariaLabel={messages().removeLabel({ name: props.label })} onClick={handleClick} loading={mutation.loading()} />;
}
