import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { faqMessages } from "../messages";

export default function DeleteFaqButton(props: { id: string; question: string }) {
  const locale = useLocale();
  const t = () => faqMessages.resolve([locale()]).t;
  const mutation = mutations.create<unknown, void>({
    mutation: async () => {
      const res = await apiClient[":id"].$delete({ param: { id: props.id } });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? t().deleteFailed);
      }
    },
    onSuccess: () => {
      toast.success(t().deleted);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = async () => {
    const confirmed = await prompts.confirm(t().deleteQuestion({ question: props.question }), {
      title: t().deleteTitle,
      icon: "ti ti-trash",
      confirmText: t().delete,
      cancelText: t().cancel,
      variant: "danger",
    });
    if (confirmed) mutation.mutate();
  };

  return (
    <Tooltip.Anchor content={t().deleteTitle}>
      <IconButton
        size="sm"
        variant="danger"
        label={t().deleteLabel({ question: props.question })}
        onClick={handleClick}
        loading={mutation.loading()}
        loadingLabel={t().deletingLabel({ question: props.question })}
      >
        <i class="ti ti-trash" aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
}
