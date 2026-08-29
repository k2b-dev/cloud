import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { CreateFaq, FaqAudience } from "@/contracts";
import { faqMessages } from "../messages";

export default function CreateFaqButton() {
  const locale = useLocale();
  const t = () => faqMessages.resolve([locale()]).t;
  const audiences = () => [
    { id: "anonymous" as const, label: t().anonymousFull, description: t().anonymousDescription },
    { id: "guest" as const, label: t().guests, description: t().guestsDescription },
    { id: "user" as const, label: t().fullUsers, description: t().usersDescription },
  ];
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
    const result = await prompts.form({
      title: t().createTitle,
      icon: "ti ti-plus",
      confirmText: t().create,
      fields: {
        question: {
          type: "text" as const,
          label: t().question,
          placeholder: t().questionPlaceholder,
          required: true,
        },
        answer: {
          type: "text" as const,
          label: t().answer,
          placeholder: t().answerPlaceholder,
          multiline: true,
          required: true,
        },
        audienceAnonymous: {
          type: "boolean" as const,
          label: audiences()[0]!.label,
          description: audiences()[0]!.description,
          default: false,
        },
        audienceGuest: {
          type: "boolean" as const,
          label: audiences()[1]!.label,
          description: audiences()[1]!.description,
          default: true,
        },
        audienceUser: {
          type: "boolean" as const,
          label: audiences()[2]!.label,
          description: audiences()[2]!.description,
          default: true,
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
    <Button size="sm" onClick={handleClick} loading={mutation.loading()} loadingLabel={t().creating}>
      <i class="ti ti-plus" aria-hidden="true" />
      {t().newEntry}
    </Button>
  );
}
