import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, SettingsGroup, toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { useSpaceMessages } from "../../messages";
import { readErrorMessage } from "./utils";

export function DangerZone(props: { spaceId: string; spaceName: string }) {
  const m = useSpaceMessages();
  const deleteMut = mutations.create<void, { spaceId: string }>({
    mutation: async ({ spaceId }) => {
      const res = await apiClient[":id"].$delete({
        param: { id: spaceId },
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, m.deleteSpaceFailed));
      }
    },
    onSuccess: () => {
      toast.success(m.spaceDeleted);
      navigateTo("/app/spaces");
    },
    onError: (err) => prompts.error(err.message),
  });
  let confirmPending = false;
  const confirmDelete = async () => {
    if (confirmPending || deleteMut.loading()) return;
    confirmPending = true;
    try {
      const confirmed = await prompts.confirm(m.deleteSpaceConfirm({ name: props.spaceName }), {
        title: m.deleteSpace,
        variant: "danger",
      });
      if (confirmed) void deleteMut.mutate({ spaceId: props.spaceId });
    } finally {
      confirmPending = false;
    }
  };

  return (
    <SettingsGroup title={m.deleteSpace} description={m.deleteSpaceDescription}>
      <SettingsGroup.Action>
        <Button type="button" variant="danger" onClick={() => void confirmDelete()} disabled={deleteMut.loading()}>
          <i class={`ti ${deleteMut.loading() ? "ti-loader-2 animate-spin" : "ti-trash"}`} aria-hidden="true" />
          {m.deleteSpace}
        </Button>
      </SettingsGroup.Action>
    </SettingsGroup>
  );
}
