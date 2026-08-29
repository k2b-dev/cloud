import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { hostMessages } from "./messages";

const NewHostgroup = () => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const mutation = mutations.create<void, { name: string; description?: string }>({
    mutation: async (vars) => {
      const res = await apiClient.hostgroups.$post({ json: vars });
      if (!res.ok) {
        throw new Error(t().failedCreateGroup);
      }
    },
    onSuccess: () => {
      toast.success(t().groupCreated);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = async () => {
    const result = await prompts.form({
      title: t().newGroup,
      icon: "ti ti-plus",
      confirmText: t().create,
      fields: {
        name: {
          type: "text" as const,
          label: t().name,
          placeholder: t().groupNamePlaceholder,
          required: true,
        },
        description: {
          type: "text" as const,
          label: t().description,
          placeholder: t().optionalDescription,
        },
      },
    });
    if (result?.name) {
      await mutation.mutate({
        name: result.name,
        description: result.description,
      });
    }
  };

  return (
    <Button size="sm" variant="secondary" onClick={handleClick} loading={mutation.loading()} loadingLabel={t().creatingGroup}>
      <i class="ti ti-plus" aria-hidden="true" />
      {t().newGroup}
    </Button>
  );
};

export default NewHostgroup;
