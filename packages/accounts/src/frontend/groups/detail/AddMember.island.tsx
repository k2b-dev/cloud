import { EntitySearch } from "@k2b/cloud/account/ui";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { showAccountActionNotice } from "../../action-notice";
import { useAccountsMessages } from "../../messages";

type AddMemberProps = {
  /** Group id */
  groupId: string;
  /** Provider of the current group */
  groupProvider: "ipa" | "local";
  /** "members" or "managers" */
  membershipRole: "members" | "managers";
  /** Search for users */
  searchUsers?: boolean;
  /** Search for groups */
  searchGroups?: boolean;
  /** User UUIDs to exclude (already members/managers) */
  excludeUserIds?: string[];
  /** CNs to exclude (already members/managers) */
  excludeGroups?: string[];
  excludeServiceAccountIds?: string[];
};

export default function AddMember(props: AddMemberProps) {
  const messages = useAccountsMessages();
  const mutation = mutations.create<void, { type: "user" | "group" | "service_account"; id: string }>({
    mutation: async (vars) => {
      const res =
        props.membershipRole === "members"
          ? await apiClient.groups[":id"].members.$post({ param: { id: props.groupId }, json: vars })
          : vars.type !== "service_account"
            ? await apiClient.groups[":id"].managers.$post({ param: { id: props.groupId }, json: { type: vars.type, id: vars.id } })
            : undefined;
      if (!res) throw new Error(messages().addManagerFailed);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? (props.membershipRole === "members" ? messages().addMemberFailed : messages().addManagerFailed));
      }
      await showAccountActionNotice(
        {
          action: props.membershipRole === "members" ? "group.member.add" : "group.manager.add",
          id: props.groupId,
          provider: props.groupProvider,
          relatedId: vars.id,
        },
        messages(),
      );
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = () => {
    const title = props.membershipRole === "members" ? messages().addMember : messages().addManager;
    const icon = props.membershipRole === "members" ? "ti ti-user-plus" : "ti ti-shield-plus";

    prompts.dialog(
      (close) => (
        <EntitySearch
          providers={[props.groupProvider]}
          includeUsers={props.searchUsers !== false}
          includeGroups={props.searchGroups}
          includeServiceAccounts={props.membershipRole === "members" && props.groupProvider === "local"}
          serviceAccountKinds={["standalone", "agent"]}
          serviceAccountStatus="active"
          excludeServiceAccountIds={props.excludeServiceAccountIds}
          excludeUserIds={props.excludeUserIds}
          excludeGroupIds={props.excludeGroups}
          placeholder={
            props.membershipRole === "members" && props.groupProvider === "local"
              ? messages().searchMembers
              : props.searchGroups
                ? messages().searchUsersOrGroups
                : messages().searchUsers
          }
          disabled={mutation.loading()}
          onSelect={async (result) => {
            close();
            if (result.type === "user") await mutation.mutate({ type: "user", id: result.userId });
            else if (result.type === "group") await mutation.mutate({ type: "group", id: result.groupId });
            else if (result.type === "service_account") await mutation.mutate({ type: "service_account", id: result.serviceAccountId });
          }}
        />
      ),
      { title, icon },
    );
  };

  return (
    <Button size="sm" variant="subtle" onClick={handleClick} disabled={mutation.loading()}>
      <i class={props.membershipRole === "members" ? "ti ti-user-plus" : "ti ti-shield-plus"} />
      <span>{mutation.loading() ? messages().adding : messages().add}</span>
    </Button>
  );
}
