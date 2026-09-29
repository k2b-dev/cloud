import { mutation } from "@k2b/stdlib/solid";
import { Button, InlineGuidance, NoticeCard, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { accentTokens } from "../../accent";
import { apiClient } from "../../api/client";
import { venueMessages } from "../../messages";

const readError = async (res: Pick<Response, "json">, fallback: string): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

function FeedbackForm(props: { venueId: string; accentColor: string; onSubmitted: () => void }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const hintId = createUniqueId();
  // Every entry needs a rating (1-5); nothing is preselected, so a comment never sends a rating the visitor did not choose.
  const [rating, setRating] = createSignal<number | null>(null);
  const [hoverRating, setHoverRating] = createSignal<number | null>(null);
  const [comment, setComment] = createSignal("");

  const submit = mutation.create<void, { rating: number; comment: string | null }>({
    mutation: async (input) => {
      const res = await apiClient.public[":id"].feedback.$post({ param: { id: props.venueId }, json: input });
      if (!res.ok) throw new Error(await readError(res, t().submitFeedbackFailed));
    },
    onSuccess: () => {
      setRating(null);
      setComment("");
      toast.success(t().feedbackThanksToast);
      props.onSubmitted();
    },
    onError: (err) => prompts.error(err.message),
  });
  const send = () => {
    const chosen = rating();
    if (chosen !== null) void submit.mutate({ rating: chosen, comment: comment().trim() || null });
  };

  return (
    <div class="grid gap-4" style={accentTokens(props.accentColor)}>
      <NoticeCard tone="neutral" icon={false}>
        {t().anonymousFeedbackPrivacy}
      </NoticeCard>
      <fieldset class="grid gap-2">
        <legend class="mb-2 flex w-full items-baseline justify-between gap-3 text-sm font-medium text-primary">
          <span>{t().rating}</span>
          <span class="text-xs font-normal text-secondary">
            {rating() === null ? t().ratingRequired : t().ratingValue({ count: rating()! })}
          </span>
        </legend>
        <div class="grid grid-cols-5 gap-2">
          <For each={[1, 2, 3, 4, 5]}>
            {(value) => {
              const active = () => value <= (hoverRating() ?? rating() ?? 0);
              return (
                <label
                  class="flex h-12 cursor-pointer items-center justify-center rounded-xl border text-3xl transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-amber-400"
                  classList={{
                    "border-amber-300 bg-amber-50 text-amber-600 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400":
                      active(),
                    "border-zinc-200 bg-zinc-50 text-zinc-400 hover:border-amber-200 hover:text-amber-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500 dark:hover:border-amber-500/40 dark:hover:text-amber-400":
                      !active(),
                  }}
                  onMouseEnter={() => setHoverRating(value)}
                  onMouseLeave={() => setHoverRating(null)}
                >
                  <input
                    type="radio"
                    name="venue-feedback-rating"
                    value={value}
                    class="sr-only"
                    checked={rating() === value}
                    onChange={() => setRating(value)}
                    aria-label={t().starRating({ count: value })}
                  />
                  <i class="ti ti-star" aria-hidden="true" />
                </label>
              );
            }}
          </For>
        </div>
      </fieldset>
      <TextInput
        label={t().comment}
        icon="ti ti-message"
        placeholder={t().optionalComment}
        value={comment}
        onValueChange={setComment}
        multiline
        lines={4}
      />
      <div class="grid gap-2">
        <Button
          type="button"
          size="sm"
          class="w-full"
          // Inline, so the accent wins over the button's own variant colors.
          style={{ "background-color": "var(--venue-accent)", "border-color": "var(--venue-accent)", color: "var(--venue-on-accent)" }}
          disabled={rating() === null || submit.loading()}
          aria-describedby={rating() === null ? hintId : undefined}
          onClick={send}
        >
          {submit.loading() ? t().submitting : t().submitFeedback}
        </Button>
        <Show when={rating() === null}>
          <InlineGuidance id={hintId} tone="neutral" icon="ti ti-star">
            {t().chooseRatingToSend}
          </InlineGuidance>
        </Show>
      </div>
    </div>
  );
}

export default function PublicFeedbackForm(props: { venueId: string; accentColor: string; variant?: "button" | "page" }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [submitted, setSubmitted] = createSignal(false);
  const openFeedback = () => {
    void prompts.dialog<void>((close) => <FeedbackForm venueId={props.venueId} accentColor={props.accentColor} onSubmitted={close} />, {
      title: t().shareFeedback,
      icon: "ti ti-star",
      size: "small",
    });
  };

  if (props.variant === "page") {
    return (
      <Show
        when={!submitted()}
        fallback={
          <div class="flex flex-col items-center gap-4 py-10 text-center" style={accentTokens(props.accentColor)}>
            <span class="flex size-14 items-center justify-center rounded-full bg-[var(--venue-accent)] text-2xl text-[var(--venue-on-accent)]">
              <i class="ti ti-check" aria-hidden="true" />
            </span>
            <div>
              <h2 class="text-xl font-semibold text-primary">{t().thankYou}</h2>
              <p class="mt-1 text-sm text-secondary">{t().feedbackSubmitted}</p>
            </div>
          </div>
        }
      >
        <FeedbackForm venueId={props.venueId} accentColor={props.accentColor} onSubmitted={() => setSubmitted(true)} />
      </Show>
    );
  }

  return (
    <button
      type="button"
      class="paper flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:paper-highlighted"
      style={accentTokens(props.accentColor)}
      onClick={openFeedback}
    >
      <span class="flex items-center gap-3">
        <span
          class="flex size-9 items-center justify-center rounded-xl bg-[var(--venue-accent)] text-lg text-[var(--venue-on-accent)]"
          aria-hidden="true"
        >
          <i class="ti ti-star" />
        </span>
        <span>
          <span class="block text-base font-semibold text-primary">{t().feedback}</span>
          <span class="block text-xs text-dimmed">{t().anonymousRating}</span>
        </span>
      </span>
      <i class="ti ti-message-star text-xl text-dimmed" aria-hidden="true" />
    </button>
  );
}
