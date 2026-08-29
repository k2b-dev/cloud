import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { FaqAudience, FaqEntry, UpdateFaq } from "@/contracts";
import { faqMessages } from "../messages";

export default function EditFaqButton(props: { entry: FaqEntry }) {
  const locale = useLocale();
  const t = () => faqMessages.resolve([locale()]).t;
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
    const audienceSet = new Set<FaqAudience>(props.entry.audience);
    const result = await prompts.form({
      title: t().editTitle,
      icon: "ti ti-pencil",
      confirmText: t().save,
      fields: {
        question: {
          type: "text" as const,
          label: t().question,
          required: true,
          default: props.entry.question,
        },
        answer: {
          type: "text" as const,
          label: t().answer,
          multiline: true,
          required: true,
          default: props.entry.answer,
        },
        audienceAnonymous: {
          type: "boolean" as const,
          label: t().anonymousFull,
          description: t().anonymousDescription,
          default: audienceSet.has("anonymous"),
        },
        audienceGuest: {
          type: "boolean" as const,
          label: t().guests,
          description: t().guestsDescription,
          default: audienceSet.has("guest"),
        },
        audienceUser: {
          type: "boolean" as const,
          label: t().fullUsers,
          description: t().usersDescription,
          default: audienceSet.has("user"),
        },
      },
    });

    if (!result) return;

    const audience: FaqAudience[] = [];
    if (result.audienceAnonymous) audience.push("anonymous");
    if (result.audienceGuest) audience.push("guest");
    if (result.audienceUser) audience.push("user");

    if (audience.length === 0) {
      prompts.error(t().chooseAudience);
      return;
    }

    mutation.mutate({
      question: result.question.trim(),
      answer: result.answer.trim(),
      audience,
    });
  };

  return (
    <Tooltip.Anchor content={t().edit}>
      <IconButton
        size="sm"
        label={t().editLabel({ question: props.entry.question })}
        onClick={handleClick}
        loading={mutation.loading()}
        loadingLabel={t().editingLabel({ question: props.entry.question })}
      >
        <i class="ti ti-pencil" aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );
}
