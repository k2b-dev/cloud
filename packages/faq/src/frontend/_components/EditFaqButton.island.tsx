import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { resolveFaqTranslation } from "@/content";
import type { FaqEntry, UpdateFaq } from "@/contracts";
import { faqMessages } from "../messages";
import { openFaqEntryDialog } from "./FaqEntryDialog";

export default function EditFaqButton(props: { entry: FaqEntry }) {
  const locale = useLocale();
  const t = () => faqMessages.resolve([locale()]).t;
  const question = () => resolveFaqTranslation(props.entry.translations, locale()).question;
  const mutation = mutations.create<unknown, UpdateFaq>({
    mutation: async (data) => {
      const res = await apiClient[":id"].$patch({
        param: { id: props.entry.id },
        json: data,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? t().updateFailed);
      }
    },
    onSuccess: () => {
      toast.success(t().updated);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = async () => {
    const result = await openFaqEntryDialog({
      title: t().editTitle,
      icon: "ti ti-pencil",
      confirmText: t().save,
      entry: props.entry,
    });

    if (!result) return;
    mutation.mutate(result);
  };

  return (
    <Tooltip.Anchor content={t().edit}>
      <IconButton
        size="sm"
        label={t().editLabel({ question: question() })}
        onClick={handleClick}
        loading={mutation.loading()}
        loadingLabel={t().editingLabel({ question: question() })}
      >
        <i class="ti ti-pencil" aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
}
