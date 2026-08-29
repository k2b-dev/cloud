import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { hostMessages } from "./messages";

type DeleteHostgroupProps = {
  cn: string;
};

const DeleteHostgroup = (props: DeleteHostgroupProps) => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const mutation = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient.hostgroups[":cn"].$delete({
        param: { cn: props.cn },
      });
      if (!res.ok) {
        throw new Error(t().failedDeleteGroup);
      }
    },
    onSuccess: () => {
      toast.success(t().groupDeleted);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = async () => {
    const confirmed = await prompts.confirm(t().deleteGroupConfirm({ name: props.cn }), {
      title: t().deleteGroup,
      icon: "ti ti-trash",
      confirmText: t().delete,
      cancelText: t().cancel,
      variant: "danger",
    });
    if (confirmed) {
      await mutation.mutate();
    }
  };

  return (
    <Tooltip.Anchor content={t().deleteGroupNamed({ name: props.cn })}>
      <IconButton
        size="xs"
        variant="danger"
        label={t().deleteGroupNamed({ name: props.cn })}
        onClick={handleClick}
        loading={mutation.loading()}
        loadingLabel={t().deletingGroup({ name: props.cn })}
      >
        <i class="ti ti-trash" aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
};

export default DeleteHostgroup;
