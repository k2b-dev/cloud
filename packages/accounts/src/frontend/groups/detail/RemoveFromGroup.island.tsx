import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, RemoveButton } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { useAccountsMessages } from "../../messages";

type RemoveFromGroupProps = {
  /** Group id to remove from parent */
  groupId: string;
  /** Parent group id */
  parentGroupId: string;
  /** Parent group label */
  parentGroupName: string;
};

export default function RemoveFromGroup(props: RemoveFromGroupProps) {
  const messages = useAccountsMessages();
  const mutation = mutations.create<void, void>({
    mutation: async () => {
      // Remove this group from the parent group
      const res = await apiClient.groups[":id"].members.$delete({
        param: { id: props.parentGroupId },
        json: { type: "group", id: props.groupId },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? messages().removeFromGroupFailed);
      }
    },
    onSuccess: () => {
      refreshCurrentPath();
    },
    onError: (err) => {
      prompts.error(err.message);
    },
  });

  const handleClick = async () => {
    const confirmed = await prompts.confirm(messages().removeFromGroupConfirm({ name: props.parentGroupName }), {
      title: messages().removeFromGroup,
      icon: "ti ti-folder-minus",
      confirmText: messages().remove,
      cancelText: messages().cancel,
      variant: "danger",
    });

    if (confirmed) {
      await mutation.mutate();
    }
  };

  return (
    <RemoveButton
      ariaLabel={messages().removeFromLabel({ name: props.parentGroupName })}
      onClick={handleClick}
      loading={mutation.loading()}
    />
  );
}
