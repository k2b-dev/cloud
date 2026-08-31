import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { CreateFaq } from "@/contracts";
import { faqMessages } from "../messages";
import { openFaqEntryDialog } from "./FaqEntryDialog";

export default function CreateFaqButton() {
  const locale = useLocale();
  const t = () => faqMessages.resolve([locale()]).t;
  const mutation = mutations.create<unknown, CreateFaq>({
    mutation: async (data) => {
      const res = await apiClient.index.$post({ json: data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? t().createFailed);
      }
    },
    onSuccess: () => {
      toast.success(t().created);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = async () => {
    const result = await openFaqEntryDialog({
      title: t().createTitle,
      icon: "ti ti-plus",
      confirmText: t().create,
    });

    if (!result) return;
    mutation.mutate(result);
  };

  return (
    <Button size="sm" onClick={handleClick} loading={mutation.loading()} loadingLabel={t().creating}>
      <i class="ti ti-plus" aria-hidden="true" />
      {t().newEntry}
    </Button>
  );
}
