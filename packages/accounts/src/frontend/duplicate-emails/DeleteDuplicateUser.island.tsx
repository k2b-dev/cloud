import { refreshCurrentPath } from "@k2b/ssr/nav";
import { Button } from "@k2b/ui";
import { useAccountsMessages } from "../messages";
import { createDeleteUserAction } from "../users/delete-user";

type Props = Parameters<typeof createDeleteUserAction>[0] & { disabled?: boolean; disabledReason?: string };

// Only the serializable target crosses the island boundary; refresh is local.
export default function DeleteDuplicateUser(props: Omit<Props, "onDeleted">) {
  const messages = useAccountsMessages();
  const action = createDeleteUserAction({
    user: props.user,
    onDeleted: () => {
      refreshCurrentPath();
    },
  });
  return (
    <Button
      size="sm"
      variant="danger"
      disabled={props.disabled || action.loading()}
      loading={action.loading()}
      title={props.disabledReason}
      aria-label={messages().duplicateDeleteLabel({ uid: props.user.uid })}
      onClick={() => {
        if (!props.disabled) void action.run();
      }}
    >
      {messages().delete}
    </Button>
  );
}
