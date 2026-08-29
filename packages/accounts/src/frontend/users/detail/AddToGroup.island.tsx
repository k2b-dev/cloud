import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts } from "@k2b/ui";
import { EntitySearch } from "@valentinkolb/cloud/account/ui";
import { apiClient } from "@/api/client";
import { useAccountsMessages } from "../../messages";

type AddToGroupProps = {
  id: string;
  userProvider: "ipa" | "local";
  /** Group IDs the user is already a member of */
  excludeGroups: string[];
};

export default function AddToGroup(props: AddToGroupProps) {
  const messages = useAccountsMessages();
  const mutation = mutations.create<void, string>({
    mutation: async (groupId) => {
      const res = await apiClient.groups[":id"].members.$post({
        param: { id: groupId },
        json: { type: "user", id: props.id },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? messages().addUserFailed);
      }
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = () => {
    prompts.dialog(
      (close) => (
        <EntitySearch
          providers={props.userProvider === "local" ? ["local"] : undefined}
          includeGroups
          excludeGroupIds={props.excludeGroups}
          placeholder={messages().searchGroups}
          disabled={mutation.loading()}
          onSelect={async (result) => {
            if (result.type === "group") {
              close();
              await mutation.mutate(result.groupId);
            }
          }}
        />
      ),
      { title: messages().addToGroup, icon: "ti ti-users-plus" },
    );
  };

  return (
    <Button size="sm" variant="subtle" onClick={handleClick} disabled={mutation.loading()}>
      <i class="ti ti-plus" />
      <span>{mutation.loading() ? messages().adding : messages().add}</span>
    </Button>
  );
}
