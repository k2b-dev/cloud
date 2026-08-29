import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { hostMessages } from "./messages";

type Props = {
  cn: string;
  description: string | null;
};

const EditHostgroup = (props: Props) => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const mutation = mutations.create<void, { description?: string }>({
    mutation: async (vars) => {
      const res = await apiClient.hostgroups[":cn"].$patch({
        param: { cn: props.cn },
        json: vars,
      });
      if (!res.ok) {
        throw new Error(t().failedUpdateGroup);
      }
    },
    onSuccess: () => {
      toast.success(t().groupUpdated);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = async () => {
    const result = await prompts.form({
      title: t().editNamed({ name: props.cn }),
      icon: "ti ti-pencil",
      confirmText: t().save,
      fields: {
        description: {
          type: "text" as const,
          label: t().description,
          placeholder: t().optionalDescription,
          default: props.description ?? "",
        },
      },
    });
    if (result) {
      await mutation.mutate({ description: result.description ?? "" });
    }
  };

  return (
    <Tooltip.Anchor content={t().editGroup({ name: props.cn })}>
      <IconButton
        size="xs"
        label={t().editGroup({ name: props.cn })}
        onClick={handleClick}
        loading={mutation.loading()}
        loadingLabel={t().editingGroup({ name: props.cn })}
      >
        <i class="ti ti-pencil" aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
};

export default EditHostgroup;
