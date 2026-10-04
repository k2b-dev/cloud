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

/** Removes another person's phone from the mobile app; its app sessions end at once. */
export default function RemoveAppDevice(props: Props) {
  const messages = useAccountsMessages();
  const removeMutation = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient.users[":id"]["app-devices"][":deviceId"].$delete({
        param: { id: props.userId, deviceId: props.deviceId },
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        const message = data && typeof data === "object" && "message" in data && typeof data.message === "string" ? data.message : null;
        throw new Error(message ?? messages().removeAppDeviceFailed);
      }
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (error) => prompts.error(error.message),
  });

  const remove = async () => {
    const confirmed = await prompts.confirm(messages().removeAppDeviceConfirm({ name: props.name }), {
      title: messages().removeAppDevice,
      icon: "ti ti-device-mobile-off",
      confirmText: messages().removeAppDevice,
      cancelText: messages().cancel,
      variant: "danger",
    });
    if (confirmed) await removeMutation.mutate();
  };

  return (
    <RemoveButton ariaLabel={messages().removeAppDeviceLabel({ name: props.name })} onClick={remove} loading={removeMutation.loading()} />
  );
}
