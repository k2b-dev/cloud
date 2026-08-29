import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { gatewayOpsMessages } from "../messages";

const readErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

const isRemovedApp = (value: unknown): value is { id: string } =>
  Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string");

export default function RemoveRegisteredAppButton(props: { id: string; name: string; disabled?: boolean }) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const removeApp = mutation.create<{ id: string } | null, void>({
    mutation: async () => {
      const confirmed = await prompts.confirm(
        t.removeAppConfirm({ name: props.name }),
        {
          title: t.removeOfflineApp,
          icon: "ti ti-trash",
          confirmText: t.remove,
          variant: "danger",
        },
      );
      if (!confirmed) return null;
      const response = await apiClient.apps[":id"].$delete({ param: { id: props.id } });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.removeAppFailed));
      const body = await response.json();
      if (!isRemovedApp(body)) throw new Error(t.unexpectedRemoveResponse);
      return body;
    },
    onSuccess: (result) => {
      if (!result || result.id !== props.id) return;
      toast.success(t.registeredAppRemoved);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });

  return (
    <Tooltip.Anchor content={props.disabled ? t.onlyOfflineAppsRemovable : t.removeOfflineApp}>
      <Button type="button" variant="danger" size="sm" disabled={props.disabled || removeApp.loading()} onClick={() => removeApp.mutate()}>
        <i class={`ti ${removeApp.loading() ? "ti-loader-2 animate-spin" : "ti-trash"}`} />
        {t.remove}
      </Button>
    </Tooltip.Anchor>
  );
}
