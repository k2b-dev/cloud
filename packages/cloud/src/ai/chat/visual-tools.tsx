import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  ChoiceList,
  MarkdownEditor,
  prompts,
  Slider,
  StatCell,
  type StatCellAccent,
  StatGrid,
  useLocale,
} from "@k2b/ui";
import { createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import { blockWords } from "../../blocks/messages";
import { CLOUD_AI_TEXT_EDITOR_FEEDBACK_MAX_CHARS, CLOUD_AI_TEXT_EDITOR_MAX_CHARS } from "../default-tool-contracts";
import { isRecord, jsonPreview } from "./message-utils";
import { aiChatMessages } from "./messages";
import { useAiToolDisclosure } from "./tool-disclosure";

/**
 * One `card` tool call as a single stat tile, the same look as key figures in views. Its arguments stay as they
 * were; the card has no better or worse direction, so a trend stays neutral and `tone` no longer colors anything.
 * Nothing compares the tile with a neighbor, so its text wraps: older cards with a long value or caption stay whole.
 */
export function CloudCardBlock(props: { args: unknown }) {
  const card = () => (isRecord(props.args) ? props.args : null);
  const emoji = () => (typeof card()?.emoji === "string" ? String(card()?.emoji).trim() : "");
  const locale = useLocale();
  const title = () => String(card()?.title ?? aiChatMessages(locale()).cardFallback);
  const value = () => String(card()?.value ?? "");
  const caption = () => (typeof card()?.caption === "string" ? String(card()!.caption) : "");
  const legacyTrend = () => {
    const trend = card()?.trend;
    return isRecord(trend) ? trend : null;
  };
  const trendValue = () => (typeof card()?.trendValue === "string" ? String(card()!.trendValue) : String(legacyTrend()?.value ?? ""));
  const trendLabel = () => (typeof card()?.trendLabel === "string" ? String(card()!.trendLabel) : String(legacyTrend()?.label ?? ""));
  const trendDirection = () => {
    const direction = card()?.trendDirection ?? legacyTrend()?.direction;
    return direction === "up" || direction === "down" || direction === "flat" ? direction : "flat";
  };
  const accent = (): StatCellAccent | undefined => {
    const text = [trendValue(), trendLabel()].filter(Boolean).join(" ");
    if (!text) return undefined;
    const direction = trendDirection();
    return {
      tone: "zinc",
      icon: direction === "up" ? "ti ti-trending-up" : direction === "down" ? "ti ti-trending-down" : "ti ti-minus",
      text,
    };
  };

  return (
    <Show
      when={card()}
      fallback={
        <pre class="max-h-52 overflow-auto rounded-md bg-zinc-950/5 p-2 text-xs text-primary dark:bg-white/5">
          {jsonPreview(props.args)}
        </pre>
      }
    >
      <StatGrid columns={1} class="max-w-sm">
        <StatCell label={emoji() ? `${emoji()} ${title()}` : title()} value={value()} sub={caption() || undefined} accent={accent()} wrap />
      </StatGrid>
    </Show>
  );
}

export function CloudSurveyBlock(props: {
  args: unknown;
  disabled?: boolean;
  disabledLabel?: string;
  onSubmit?: (result: unknown) => void | Promise<void>;
}) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const survey = () => (isRecord(props.args) ? props.args : null);
  const questions = () => (Array.isArray(survey()?.questions) ? (survey()!.questions as unknown[]).filter(isRecord) : []);
  const surveyId = createUniqueId();
  const [answers, setAnswers] = createSignal<Record<string, unknown>>({});
  const [error, setError] = createSignal<string | null>(null);
  const [submitted, setSubmitted] = createSignal(false);
  const submission = mutation.create<void, unknown>({
    mutation: async (result) => {
      if (!props.onSubmit) throw new Error(t().surveyFailed);
      await props.onSubmit(result);
    },
    onSuccess: () => setSubmitted(true),
    onError: (submissionError) => setError(submissionError.message || t().surveyFailed),
  });

  const setAnswer = (id: string, value: unknown) => setAnswers((prev) => ({ ...prev, [id]: value }));
  const toggleAnswer = (id: string, value: string, checked: boolean) => {
    const current = Array.isArray(answers()[id]) ? ([...(answers()[id] as string[])] as string[]) : [];
    setAnswer(id, checked ? [...current, value] : current.filter((entry) => entry !== value));
  };
  const submit = async () => {
    const missing = questions().find((question) => {
      if (!question.required) return false;
      const value = answers()[String(question.id ?? "")];
      return Array.isArray(value) ? value.length === 0 : value === undefined || value === "";
    });
    if (missing) {
      setError(t().surveyRequired);
      return;
    }
    setError(null);
    if (!submission.loading()) await submission.mutate({ submitted: true, answers: answers() });
  };
  const disabled = () => Boolean(props.disabled || submitted() || submission.loading() || !props.onSubmit);

  // One question with options counts its choice in the foot, like a view's choice.
  const counted = () => {
    const list = questions();
    const only = list.length === 1 ? list[0]! : undefined;
    if (!only || (only.type !== "single" && only.type !== "multiple")) return undefined;
    const value = answers()[String(only.id ?? "")];
    return Array.isArray(value) ? value.length : value === undefined || value === "" ? 0 : 1;
  };

  // The same flat choice as a view's `Choice` block: no hull, the question in bold, options as flat cards with the 2 px
  // edge that tint when chosen, then the state and one quiet answer button.
  return (
    // Gustav asks it, so it takes the AI colour wherever it stands, like an approval frame.
    <section class="cloud-blocks__choice w-full min-w-0" data-k2b-primary="ai" aria-labelledby={`${surveyId}-title`}>
      <p class="cloud-blocks__question" id={`${surveyId}-title`}>
        {String(survey()?.title ?? t().surveyKind)}
      </p>
      <Show when={typeof survey()?.description === "string"}>
        <p class="cloud-blocks__hint">{String(survey()?.description)}</p>
      </Show>
      <div class="mt-2 space-y-4">
        <For each={questions()}>
          {(question, index) => {
            const id = () => String(question.id ?? "");
            // The answer key may hold spaces or repeat; the DOM label ID comes from the question's place instead.
            const labelId = () => `${surveyId}-question-${index()}`;
            const options = () => (Array.isArray(question.options) ? (question.options as unknown[]).filter(isRecord) : []);
            const chosen = () => (Array.isArray(answers()[id()]) ? (answers()[id()] as string[]) : []);
            return (
              <div class="grid gap-2">
                <p id={labelId()} class="text-xs font-medium text-primary">
                  {String(question.label ?? "")}
                  <Show when={question.required}>
                    <span class="text-[var(--k2b-danger-text)]"> *</span>
                  </Show>
                </p>
                <Show when={question.type === "single"}>
                  <ChoiceList
                    aria-label={String(question.label ?? "") || String(survey()?.title ?? t().surveyKind)}
                    value={answers()[id()] === undefined ? null : String(answers()[id()])}
                    disabled={disabled()}
                    options={options().map((option) => ({
                      value: String(option.value ?? ""),
                      label: String(option.label ?? option.value ?? ""),
                    }))}
                    onValueChange={(value) =>
                      setAnswer(id(), options().find((option) => String(option.value ?? "") === value)?.value ?? value)
                    }
                  />
                </Show>
                <Show when={question.type === "multiple"}>
                  <div class="cloud-survey__checks" role="group" aria-labelledby={labelId()}>
                    <For each={options()}>
                      {(option) => (
                        <CheckboxCard
                          label={String(option.label ?? option.value ?? "")}
                          value={chosen().includes(String(option.value))}
                          disabled={disabled()}
                          onValueChange={(on) => toggleAnswer(id(), String(option.value), on)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={question.type === "text"}>
                  <input
                    class="input h-9 w-full text-sm"
                    aria-labelledby={labelId()}
                    disabled={disabled()}
                    placeholder={typeof question.placeholder === "string" ? question.placeholder : ""}
                    value={String(answers()[id()] ?? "")}
                    onInput={(event) => setAnswer(id(), event.currentTarget.value)}
                  />
                </Show>
                <Show when={question.type === "rating"}>
                  <Slider
                    aria-label={String(question.label ?? "") || t().surveyKind}
                    disabled={disabled()}
                    min={typeof question.min === "number" ? question.min : 1}
                    max={typeof question.max === "number" ? question.max : 5}
                    value={() => Number(answers()[id()] ?? question.min ?? 1)}
                    showValue={false}
                    onValueChange={(value) => setAnswer(id(), value)}
                  />
                </Show>
              </div>
            );
          }}
        </For>
      </div>
      <div class="cloud-blocks__choice-foot">
        <Switch fallback={<span />}>
          <Match when={error()}>
            <span class="cloud-blocks__choice-state" role="alert" data-tone="error">
              {error()}
            </span>
          </Match>
          <Match when={submitted()}>
            <span class="cloud-blocks__choice-state" data-tone="done">
              <i class="ti ti-circle-check" aria-hidden="true" />
              {t().surveySubmitted}
            </span>
          </Match>
          <Match when={props.disabled || !props.onSubmit}>
            <span class="cloud-blocks__choice-state">
              <i class="ti ti-clock" aria-hidden="true" />
              {props.disabledLabel ?? t().surveyWaiting}
            </span>
          </Match>
          <Match when={counted() !== undefined}>
            <span class="cloud-blocks__choice-state">{blockWords(locale()).chosenCount({ count: counted()! })}</span>
          </Match>
        </Switch>
        <Show when={!props.disabled && !submitted() && props.onSubmit}>
          <Button variant="secondary" loading={submission.loading()} loadingLabel={t().answerSubmitting} onClick={() => void submit()}>
            <i class="ti ti-check" aria-hidden="true" />
            {String(survey()?.submitLabel ?? t().surveySubmit)}
          </Button>
        </Show>
      </div>
    </section>
  );
}

const surveyAnswerLabel = (question: Record<string, unknown> | null, value: unknown, noAnswer: string) => {
  const options = Array.isArray(question?.options) ? (question!.options as unknown[]).filter(isRecord) : [];
  const optionLabel = (entry: unknown) => {
    const match = options.find((option) => String(option.value ?? "") === String(entry));
    return String(match?.label ?? entry ?? "");
  };
  if (Array.isArray(value)) return value.map(optionLabel).filter(Boolean).join(", ") || noAnswer;
  if (typeof value === "object" && value !== null) return jsonPreview(value);
  if (value === undefined || value === null || value === "") return noAnswer;
  return optionLabel(value);
};

export function CloudSurveyResultBlock(props: { args?: unknown; result: unknown }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const survey = () => (isRecord(props.args) ? props.args : null);
  const result = () => (isRecord(props.result) ? props.result : null);
  const answers = () => (isRecord(result()?.answers) ? (result()!.answers as Record<string, unknown>) : {});
  const questions = () => (Array.isArray(survey()?.questions) ? (survey()!.questions as unknown[]).filter(isRecord) : []);
  const rows = () => {
    const knownQuestions = questions().map((question) => {
      const id = String(question.id ?? "");
      return {
        id,
        label: String(question.label ?? id),
        value: surveyAnswerLabel(question, answers()[id], t().surveyNoAnswer),
      };
    });
    const knownIds = new Set(knownQuestions.map((question) => question.id));
    const extraAnswers = Object.entries(answers())
      .filter(([id]) => !knownIds.has(id))
      .map(([id, value]) => ({ id, label: id, value: surveyAnswerLabel(null, value, t().surveyNoAnswer) }));
    return [...knownQuestions, ...extraAnswers].filter((row) => row.id);
  };

  return (
    <Show when={rows().length > 0} fallback={<p>{t().surveyNoAnswers}</p>}>
      <dl class="flex min-w-0 flex-col gap-3">
        <For each={rows()}>
          {(row) => (
            <div class="min-w-0">
              <dt class="mb-1 whitespace-pre-wrap break-words text-xs text-dimmed">{row.label}</dt>
              <dd class="whitespace-pre-wrap break-words">{row.value}</dd>
            </div>
          )}
        </For>
      </dl>
    </Show>
  );
}

export function CloudTextEditorBlock(props: {
  args: unknown;
  disabled?: boolean;
  disabledLabel?: string;
  onSubmit?: (result: unknown) => void | Promise<void>;
}) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const editor = () => (isRecord(props.args) ? props.args : null);
  const format = () => (editor()?.format === "markdown" ? "markdown" : "plain");
  const initialContent = () => (typeof editor()?.content === "string" ? String(editor()!.content) : "");
  const [content, setContent] = createSignal(initialContent());
  const [error, setError] = createSignal<string | null>(null);
  const [submitted, setSubmitted] = createSignal(false);
  const submission = mutation.create<void, unknown>({
    mutation: async (result) => {
      if (!props.onSubmit) throw new Error(t().textEditorUnavailable);
      await props.onSubmit(result);
    },
    onSuccess: () => setSubmitted(true),
    onError: (submissionError) => setError(submissionError.message || t().textEditorFailed),
  });
  const disabled = () => Boolean(props.disabled || submitted() || submission.loading() || !props.onSubmit);
  const submit = async () => {
    setError(null);
    if (!submission.loading()) await submission.mutate({ submitted: true, content: content(), format: format() });
  };
  const requestChanges = async () => {
    setError(null);
    if (submission.loading()) return;
    const result = await prompts.form({
      title: t().textEditorSuggest,
      icon: "ti ti-message",
      confirmText: t().textEditorSendFeedback,
      size: "medium",
      fields: {
        feedback: {
          type: "text",
          label: t().textEditorFeedbackLabel,
          placeholder: t().textEditorFeedbackPlaceholder,
          multiline: true,
          lines: 4,
          required: true,
          maxLength: CLOUD_AI_TEXT_EDITOR_FEEDBACK_MAX_CHARS,
        },
      },
    });
    const feedback = result?.feedback.trim();
    if (feedback) await submission.mutate({ submitted: false, feedback });
  };

  return (
    <div class="w-full min-w-0">
      <MarkdownEditor
        value={content}
        onValueChange={setContent}
        lines={14}
        maxLength={CLOUD_AI_TEXT_EDITOR_MAX_CHARS}
        aria-label={String(editor()?.title ?? t().textEditorReview)}
        spellcheck
        disabled={disabled()}
        showStats={false}
      />
      <Show when={error()}>
        <p class="mt-2 text-xs text-red-600 dark:text-red-300" role="alert">
          {error()}
        </p>
      </Show>
      <div class="mt-3 flex min-h-9 flex-wrap items-center gap-2">
        <span class="text-xs tabular-nums text-dimmed">
          {content().length.toLocaleString(locale())} / {CLOUD_AI_TEXT_EDITOR_MAX_CHARS.toLocaleString(locale())}
        </span>
        <Show
          when={!props.disabled && !submitted() && props.onSubmit}
          fallback={<p class="ml-auto text-xs text-dimmed">{props.disabledLabel ?? t().surveyWaiting}</p>}
        >
          <div class="ml-auto flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={submission.loading()} onClick={() => void requestChanges()}>
              {t().textEditorSuggest}
            </Button>
            <Button variant="ai" size="sm" loading={submission.loading()} loadingLabel={t().answerSubmitting} onClick={() => void submit()}>
              {String(editor()?.submitLabel ?? t().textEditorContinue)}
            </Button>
          </div>
        </Show>
      </div>
    </div>
  );
}

export function CloudTextEditorResultBlock(props: { blockId?: string; args?: unknown; result: unknown; continuing?: boolean }) {
  const disclosure = useAiToolDisclosure(() => props.blockId);
  const editor = () => (isRecord(props.args) ? props.args : null);
  const result = () => (isRecord(props.result) ? props.result : null);
  const content = () => (typeof result()?.content === "string" ? String(result()!.content) : "");
  const feedback = () => (result()?.submitted === false && typeof result()?.feedback === "string" ? String(result()!.feedback) : "");
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const format = () => (result()?.format === "markdown" ? "Markdown" : t().textEditorPlain);
  const state = () =>
    feedback()
      ? props.continuing
        ? t().textEditorRevising
        : t().textEditorChangesRequested
      : props.continuing
        ? t().textEditorWaiting
        : t().textEditorSubmitted;
  return (
    <details
      class="group w-full min-w-0 text-xs"
      open={disclosure.open()}
      onToggle={(event) => disclosure.onOpenChange(event.currentTarget.open)}
    >
      <summary class="inline-flex min-h-7 max-w-full cursor-pointer list-none items-center gap-1.5 py-1 leading-none text-dimmed transition-colors hover:text-primary">
        <i class="ti ti-edit shrink-0 text-base leading-none" aria-hidden="true" />
        <span class="shrink-0 font-medium">{t().textEditor}</span>
        <span class="min-w-0 truncate">
          {String(editor()?.title ?? t().textEditorReview)} · {state()}
        </span>
        <i
          class="ti ti-chevron-right shrink-0 text-base leading-none opacity-60 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div class="mt-1 w-full min-w-0 rounded-md bg-zinc-100/70 px-2.5 py-2 [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-dimmed">{feedback() ? t().textEditorFeedback : format()}</p>
        <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-primary">
          {feedback() || content() || t().textEditorEmpty}
        </pre>
      </div>
    </details>
  );
}
