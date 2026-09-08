import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts } from "@k2b/ui";
import { EntitySearch } from "@valentinkolb/cloud/account/ui";
import { apiClient } from "@/api/client";
import { showAccountActionNotice } from "../../action-notice";
import { useAccountsMessages } from "../../messages";

type AddToGroupProps = {
  /** Group id to add to another group */
  groupId: string;
  /** Provider of the current group */
  groupProvider: "ipa" | "local";
  /** IDs to exclude (already member of) */
  excludeGroups?: string[];
};

export default function AddToGroup(props: AddToGroupProps) {
  const messages = useAccountsMessages();
  const mutation = mutations.create<void, { targetGroup: string }>({
    mutation: async (vars) => {
      // Add this group as a member of the target group
      const res = await apiClient.groups[":id"].members.$post({
        param: { id: vars.targetGroup },
        json: { type: "group", id: props.groupId },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? messages().addGroupFailed);
      }
      await showAccountActionNotice(
        { action: "group.member.add", id: vars.targetGroup, provider: props.groupProvider, relatedId: props.groupId },
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

  const handleClick = () => {
    prompts.dialog(
      (close) => (
        <EntitySearch
          providers={[props.groupProvider]}
          includeGroups
          excludeGroupIds={[...(props.excludeGroups ?? []), props.groupId]}
          placeholder={messages().searchGroups}
          disabled={mutation.loading()}
          onSelect={async (result) => {
            if (result.type === "group") {
              close();
              await mutation.mutate({ targetGroup: result.groupId });
            }
          }}
        />
      ),
      { title: messages().addToGroup, icon: "ti ti-folder-plus" },
    );
  };

  return (
    <Button size="sm" variant="subtle" onClick={handleClick} disabled={mutation.loading()}>
      <i class="ti ti-folder-plus" />
      <span>{mutation.loading() ? messages().adding : messages().addToGroup}</span>
    </Button>
  );
}
