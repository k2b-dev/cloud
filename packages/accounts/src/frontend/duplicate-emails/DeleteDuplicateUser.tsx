import { Button } from "@k2b/ui/v2";
import { usePageSwap } from "@/frontend/lib/page-swap";
import { useAccountsMessages } from "../messages";
import { createDeleteUserAction } from "../users/delete-user";

type Props = Omit<Parameters<typeof createDeleteUserAction>[0], "onDeleted"> & {
  disabled?: boolean;
  /** Why the account cannot be deleted; it then names the button. */
  disabledReason?: string;
};

/** Deletes one of the accounts that share an address, after the shared confirmation; the list shows again after it. */
export default function DeleteDuplicateUser(props: Props) {
  const { showChanges } = usePageSwap();
  const messages = useAccountsMessages();
  // k2b-ui gap: the confirmation comes from `users/delete-user.tsx` (another lane), which still asks with the v1
  // `prompts.confirm`; v2's `Dialog.confirm` takes no rich content (the account line, the FreeIPA consequence).
  const action = createDeleteUserAction({ user: props.user, onDeleted: () => void showChanges() });
  return (
    <Button
      variant="ghost"
      icon="trash"
      label={props.disabledReason ?? messages().duplicateDeleteLabel({ uid: props.user.uid })}
      disabled={props.disabled}
      busy={action.loading()}
      onClick={() => {
        if (!props.disabled) void action.run();
      }}
    />
  );
}
