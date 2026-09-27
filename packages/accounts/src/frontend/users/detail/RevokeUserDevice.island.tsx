import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, RemoveButton } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { useAccountsMessages } from "../../messages";

type Props = {
  userId: string;
  deviceId: string;
  name: string;
};

export default function RevokeUserDevice(props: Props) {
  const messages = useAccountsMessages();
  const revokeMutation = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient.users[":id"].devices[":deviceId"].$delete({
        param: { id: props.userId, deviceId: props.deviceId },
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        const message = data && typeof data === "object" && "message" in data && typeof data.message === "string" ? data.message : null;
        throw new Error(message ?? messages().revokeDeviceFailed);
      }
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (error) => prompts.error(error.message),
  });

  const revoke = async () => {
    const confirmed = await prompts.confirm(messages().revokeDeviceConfirm({ name: props.name }), {
      title: messages().revokeDevice,
      icon: "ti ti-device-mobile-off",
      confirmText: messages().revokeDevice,
      cancelText: messages().cancel,
      variant: "danger",
    });
    if (confirmed) await revokeMutation.mutate();
  };

  return (
    <RemoveButton ariaLabel={messages().revokeDeviceLabel({ name: props.name })} onClick={revoke} loading={revokeMutation.loading()} />
  );
}
