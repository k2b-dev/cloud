import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, RemoveButton } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { useAccountsMessages } from "../messages";

type Props = {
  credentialId: string;
  name: string;
  disabled?: boolean;
};

export default function ServiceAccountCredentialActions(props: Props) {
  const messages = useAccountsMessages();
  const revokeMutation = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient["service-accounts"].credentials[":id"].$delete({
        param: { id: props.credentialId },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? messages().revokeApiKeyFailed);
      }
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (error) => prompts.error(error.message),
  });

  const revoke = async () => {
    const confirmed = await prompts.confirm(messages().revokeApiKeyConfirm({ name: props.name }), {
      title: messages().revokeApiKey,
      icon: "ti ti-key-off",
      confirmText: messages().revoke,
      cancelText: messages().cancel,
      variant: "danger",
    });
    if (confirmed) await revokeMutation.mutate();
  };

  return (
    <RemoveButton
      ariaLabel={messages().revokeApiKeyLabel({ name: props.name })}
      onClick={revoke}
      loading={revokeMutation.loading()}
      disabled={props.disabled}
    />
  );
}
