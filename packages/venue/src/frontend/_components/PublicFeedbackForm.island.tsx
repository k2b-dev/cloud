import { mutation } from "@k2b/stdlib/solid";
import { Button, NoticeCard, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { venueMessages } from "../../messages";

const readError = async (res: Response, fallback: string): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
};

function FeedbackForm(props: { venueId: string; accentColor: string; onSubmitted: () => void }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [rating, setRating] = createSignal(4);
  const [hoverRating, setHoverRating] = createSignal<number | null>(null);
  const [comment, setComment] = createSignal("");

  const submit = mutation.create<void, void>({
    mutation: async () => {
      const res = await apiClient.public[":id"].feedback.$post({
        param: { id: props.venueId },
        json: { rating: rating(), comment: comment().trim() || null },
      });
      if (!res.ok) throw new Error(await readError(res, t().submitFeedbackFailed));
    },
    onSuccess: () => {
      setRating(4);
      setComment("");
      toast.success(t().feedbackThanksToast);
      props.onSubmitted();
    },
    onError: (err) => prompts.error(err.message),
  });

  return (
    <div class="grid gap-4">
      <NoticeCard tone="neutral" icon={false}>
        {t().anonymousFeedbackPrivacy}
      </NoticeCard>
      <div class="grid grid-cols-5 gap-2" role="group" aria-label={t().rating} onMouseLeave={() => setHoverRating(null)}>
        <For each={[1, 2, 3, 4, 5]}>
          {(value) => {
            const active = () => value <= (hoverRating() ?? rating());
            const focused = () => hoverRating() === value;
            return (
              <button
                type="button"
                class="flex h-12 items-center justify-center rounded-xl border text-3xl shadow-sm transition-colors"
                classList={{
                  "border-amber-300 bg-amber-100 text-amber-700 ring-2 ring-amber-300/50": focused(),
                  "border-amber-200 bg-amber-50 text-amber-600": active() && !focused(),
                  "border-zinc-200 bg-zinc-50 text-zinc-300 hover:border-amber-200 hover:bg-amber-50 hover:text-amber-500": !active(),
                }}
                aria-label={t().starRating({ count: value })}
                onMouseEnter={() => setHoverRating(value)}
                onFocus={() => setHoverRating(value)}
                onBlur={() => setHoverRating(null)}
                onClick={() => setRating(value)}
              >
                <i class="ti ti-star" />
              </button>
            );
          }}
        </For>
      </div>
      <TextInput
        label={t().comment}
        icon="ti ti-message"
        placeholder={t().optionalComment}
        value={comment}
        onValueChange={setComment}
        multiline
        lines={4}
      />
      <Button
        type="button"
        size="sm"
        class="w-full border-transparent text-white"
        style={{ "background-color": props.accentColor, "border-color": props.accentColor }}
        disabled={submit.loading()}
        onClick={() => submit.mutate()}
      >
        {submit.loading() ? t().submitting : t().submitFeedback}
      </Button>
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
          <div class="flex flex-col items-center gap-4 py-10 text-center">
            <span
              class="flex size-14 items-center justify-center rounded-full text-2xl text-white"
              style={{ "background-color": props.accentColor }}
            >
              <i class="ti ti-check" />
            </span>
            <div>
              <h2 class="text-xl font-semibold text-zinc-950">{t().thankYou}</h2>
              <p class="mt-1 text-sm text-zinc-600">{t().feedbackSubmitted}</p>
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
      class="flex w-full items-center justify-between gap-3 rounded-2xl bg-white/90 px-4 py-3 text-left shadow-sm ring-1 ring-black/5 transition-colors hover:bg-zinc-50"
      onClick={openFeedback}
    >
      <span class="flex items-center gap-3">
        <span
          class="flex size-9 items-center justify-center rounded-xl text-lg text-white"
          style={{ "background-color": props.accentColor }}
          aria-hidden="true"
        >
          <i class="ti ti-star" />
        </span>
        <span>
          <span class="block text-base font-semibold text-zinc-950">{t().feedback}</span>
          <span class="block text-xs text-zinc-500">{t().anonymousRating}</span>
        </span>
      </span>
      <i class="ti ti-message-star text-xl text-zinc-500" aria-hidden="true" />
    </button>
  );
}
