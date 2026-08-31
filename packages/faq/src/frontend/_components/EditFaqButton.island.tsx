import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { IconButton, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { resolveFaqTranslation } from "@/content";
import type { FaqAudience, FaqEntry, UpdateFaq } from "@/contracts";
import { faqMessages } from "../messages";

export default function EditFaqButton(props: { entry: FaqEntry }) {
  const locale = useLocale();
  const t = () => faqMessages.resolve([locale()]).t;
  const question = () => resolveFaqTranslation(props.entry.translations, locale()).question;
  const english = props.entry.translations.en;
  if (!english) throw new Error("FAQ English translation is required");
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
        questionEn: {
          type: "text" as const,
          label: t().questionEn,
          required: true,
          default: english.question,
        },
        answerEn: {
          type: "text" as const,
          label: t().answerEn,
          multiline: true,
          required: true,
          default: english.answer,
        },
        questionDe: {
          type: "text" as const,
          label: t().questionDe,
          default: props.entry.translations.de?.question ?? "",
        },
        answerDe: {
          type: "text" as const,
          label: t().answerDe,
          multiline: true,
          default: props.entry.translations.de?.answer ?? "",
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

    const questionDe = (result.questionDe ?? "").trim();
    const answerDe = (result.answerDe ?? "").trim();
    if ((questionDe && !answerDe) || (!questionDe && answerDe)) {
      prompts.error(t().completeTranslation);
      return;
    }

    const { de: _german, ...otherTranslations } = props.entry.translations;
    mutation.mutate({
      translations: {
        ...otherTranslations,
        en: { question: result.questionEn.trim(), answer: result.answerEn.trim() },
        ...(questionDe && answerDe ? { de: { question: questionDe, answer: answerDe } } : {}),
      },
      audience,
    });
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
