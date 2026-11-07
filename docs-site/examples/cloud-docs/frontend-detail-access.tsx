import { accessMemberEntries } from "@k2b/cloud/access/members";
import type { AccessMember } from "@k2b/cloud/contracts";
import { DetailAccess } from "@k2b/ui";

type ItemAccessProps = {
  members: readonly AccessMember[];
  currentUserId: string | null;
  locale: string;
  state: "ready" | "loading" | "error";
  onRetry: () => void;
};

export function ItemAccess(props: ItemAccessProps) {
  return (
    <DetailAccess
      entries={accessMemberEntries(props.members, { currentUserId: props.currentUserId, locale: props.locale })}
      state={props.state}
      onRetry={props.onRetry}
    />
  );
}
