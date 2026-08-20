import { mutation } from "@k2b/stdlib/solid";
import { Button, MarkdownEditor, prompts, Slider } from "@k2b/ui";
import { createSignal, createUniqueId, For, Show } from "solid-js";
import { CLOUD_AI_TEXT_EDITOR_FEEDBACK_MAX_CHARS, CLOUD_AI_TEXT_EDITOR_MAX_CHARS } from "../default-tool-contracts";
import { isRecord, jsonPreview } from "./message-utils";
import { useAiToolDisclosure } from "./tool-disclosure";

const toneClass = (tone: unknown) => {
  if (tone === "blue") return "border-blue-200 bg-blue-50/65 text-blue-950 dark:border-blue-900/70 dark:bg-blue-950/25 dark:text-blue-100";
  if (tone === "green")
    return "border-emerald-200 bg-emerald-50/65 text-emerald-950 dark:border-emerald-900/70 dark:bg-emerald-950/25 dark:text-emerald-100";
  if (tone === "amber")
    return "border-amber-200 bg-amber-50/70 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/25 dark:text-amber-100";
  if (tone === "red") return "border-red-200 bg-red-50/70 text-red-950 dark:border-red-900/70 dark:bg-red-950/25 dark:text-red-100";
  if (tone === "teal") return "border-cyan-200 bg-teal-50/70 text-cyan-950 dark:border-cyan-900/70 dark:bg-cyan-950/25 dark:text-cyan-100";
  return "border-zinc-200 bg-white text-primary dark:border-zinc-800 dark:bg-zinc-900";
};

export function CloudCardBlock(props: { args: unknown }) {
  const card = () => (isRecord(props.args) ? props.args : null);
  const emoji = () => (typeof card()?.emoji === "string" ? String(card()?.emoji).trim() : "");
  const title = () => String(card()?.title ?? "Card");
  const value = () => String(card()?.value ?? "");
  const caption = () => (typeof card()?.caption === "string" ? String(card()!.caption) : "");
  const legacyTrend = () => (isRecord(card()?.trend) ? (card()!.trend as Record<string, unknown>) : null);
  const trendValue = () => (typeof card()?.trendValue === "string" ? String(card()!.trendValue) : String(legacyTrend()?.value ?? ""));
  const trendLabel = () => (typeof card()?.trendLabel === "string" ? String(card()!.trendLabel) : String(legacyTrend()?.label ?? ""));
  const trendDirection = () => {
    const direction = card()?.trendDirection ?? legacyTrend()?.direction;
    return direction === "up" || direction === "down" || direction === "flat" ? direction : "flat";
  };
  const hasTrend = () => Boolean(trendValue() || trendLabel());

  return (
    <div class={`max-w-xl rounded-md border p-2.5 ${toneClass(card()?.tone)}`}>
      <Show
        when={card()}
        fallback={
          <pre class="max-h-52 overflow-auto rounded-md bg-zinc-950/5 p-2 text-xs text-primary dark:bg-white/5">
            {jsonPreview(props.args)}
          </pre>
        }
      >
        <div class="flex items-start gap-2">
          <Show when={emoji()}>
            <span class="shrink-0 text-2xl leading-7" aria-hidden="true">
              {emoji()}
            </span>
          </Show>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold">{title()}</p>
            <p class="mt-2 text-3xl font-semibold tracking-normal">{value()}</p>
            <Show when={hasTrend()}>
              <p class="mt-1 inline-flex items-center gap-1 rounded-md bg-white/55 px-1.5 py-0.5 text-xs dark:bg-white/10">
                <i
                  class={`ti ${
                    trendDirection() === "up" ? "ti-trending-up" : trendDirection() === "down" ? "ti-trending-down" : "ti-minus"
                  } text-sm`}
                  aria-hidden="true"
                />
                <Show when={trendValue()}>{trendValue()}</Show>
                <Show when={trendLabel()}>
                  <span class="opacity-70">{trendLabel()}</span>
                </Show>
              </p>
            </Show>
            <Show when={caption()}>
              <p class="mt-2 text-xs opacity-70">{caption()}</p>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function CloudSurveyBlock(props: {
  args: unknown;
  disabled?: boolean;
  disabledLabel?: string;
  onSubmit?: (result: unknown) => void | Promise<void>;
}) {
  const survey = () => (isRecord(props.args) ? props.args : null);
  const questions = () => (Array.isArray(survey()?.questions) ? (survey()!.questions as unknown[]).filter(isRecord) : []);
  const surveyId = createUniqueId();
  const [answers, setAnswers] = createSignal<Record<string, unknown>>({});
  const [error, setError] = createSignal<string | null>(null);
  const [submitted, setSubmitted] = createSignal(false);
  const submission = mutation.create<void, unknown>({
    mutation: async (result) => {
      if (!props.onSubmit) throw new Error("Survey submission is unavailable.");
      await props.onSubmit(result);
    },
    onSuccess: () => setSubmitted(true),
    onError: (submissionError) => setError(submissionError.message || "Could not submit the survey. Try again."),
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
      setError("Please answer all required questions.");
      return;
    }
    setError(null);
    if (!submission.loading()) await submission.mutate({ submitted: true, answers: answers() });
  };
  const disabled = () => Boolean(props.disabled || submitted() || submission.loading() || !props.onSubmit);

  return (
    <div class="w-full min-w-0 overflow-hidden rounded-xl border border-[var(--k2b-border)] bg-[var(--k2b-surface)]">
      <div class="p-4">
        <div class="flex items-center gap-3">
          <span class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--k2b-ai-accent)_10%,var(--k2b-surface))] text-base text-[var(--k2b-ai-accent)]">
            <i class="ti ti-forms" aria-hidden="true" />
          </span>
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-primary">{String(survey()?.title ?? "Survey")}</p>
            <p class="text-xs text-dimmed">Survey</p>
          </div>
        </div>
        <div class="min-w-0">
          <Show when={typeof survey()?.description === "string"}>
            <p class="mt-4 text-xs text-secondary">{String(survey()?.description)}</p>
          </Show>

          <div class="mt-4 space-y-4">
            <For each={questions()}>
              {(question) => {
                const id = () => String(question.id ?? "");
                const options = () => (Array.isArray(question.options) ? (question.options as unknown[]).filter(isRecord) : []);
                return (
                  <div>
                    <p class="text-xs font-medium text-primary">
                      {String(question.label ?? "")}
                      <Show when={question.required}>
                        <span class="text-red-500"> *</span>
                      </Show>
                    </p>
                    <Show when={question.type === "single"}>
                      <div class="mt-2 grid gap-1.5">
                        <For each={options()}>
                          {(option) => (
                            <label
                              class="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--k2b-border)] px-3 py-2 text-xs text-secondary transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--k2b-focus-ring)]"
                              classList={{
                                "border-[var(--k2b-ai-accent)] text-primary": answers()[id()] === option.value,
                                "cursor-not-allowed opacity-60": disabled(),
                              }}
                            >
                              <input
                                type="radio"
                                name={`${surveyId}-${id()}`}
                                value={String(option.value ?? "")}
                                checked={answers()[id()] === option.value}
                                disabled={disabled()}
                                class="accent-[var(--k2b-ai-accent)]"
                                onChange={() => setAnswer(id(), option.value)}
                              />
                              {String(option.label ?? option.value ?? "")}
                            </label>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={question.type === "multiple"}>
                      <div class="mt-2 grid gap-1.5">
                        <For each={options()}>
                          {(option) => (
                            <label
                              class="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--k2b-border)] px-3 py-2 text-xs text-secondary transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--k2b-focus-ring)]"
                              classList={{
                                "border-[var(--k2b-ai-accent)] text-primary":
                                  Array.isArray(answers()[id()]) && (answers()[id()] as string[]).includes(String(option.value)),
                                "cursor-not-allowed opacity-60": disabled(),
                              }}
                            >
                              <input
                                type="checkbox"
                                disabled={disabled()}
                                checked={Array.isArray(answers()[id()]) && (answers()[id()] as string[]).includes(String(option.value))}
                                class="accent-[var(--k2b-ai-accent)]"
                                onChange={(event) => toggleAnswer(id(), String(option.value), event.currentTarget.checked)}
                              />
                              {String(option.label ?? option.value ?? "")}
                            </label>
                          )}
                        </For>
                      </div>
                    </Show>
                    <Show when={question.type === "text"}>
                      <input
                        class="input mt-1 h-9 w-full text-sm"
                        disabled={disabled()}
                        placeholder={typeof question.placeholder === "string" ? question.placeholder : ""}
                        value={String(answers()[id()] ?? "")}
                        onInput={(event) => setAnswer(id(), event.currentTarget.value)}
                      />
                    </Show>
                    <Show when={question.type === "rating"}>
                      <Slider
                        class="mt-2"
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

          <Show when={error()}>
            <p class="mt-2 text-xs text-red-600 dark:text-red-300">{error()}</p>
          </Show>
        </div>
      </div>
      <footer class="flex min-h-12 items-center gap-3 border-t border-[var(--k2b-border)] bg-[var(--k2b-surface-subtle)] px-4 py-2.5">
        <Show when={submitted()}>
          <span class="inline-flex items-center gap-1.5 text-xs font-medium text-secondary">
            <i class="ti ti-check text-[var(--k2b-ai-accent)]" aria-hidden="true" />
            Answer submitted. Assistant is continuing…
          </span>
        </Show>
        <Show
          when={!props.disabled && !submitted() && props.onSubmit}
          fallback={
            <Show when={!submitted()}>
              <p class="ml-auto text-xs text-dimmed">{props.disabledLabel ?? "Waiting for the assistant to continue."}</p>
            </Show>
          }
        >
          <Button
            variant="ai"
            size="sm"
            class="ml-auto"
            loading={submission.loading()}
            loadingLabel="Submitting"
            onClick={() => void submit()}
          >
            {String(survey()?.submitLabel ?? "Submit")}
          </Button>
        </Show>
      </footer>
    </div>
  );
}

const surveyAnswerLabel = (question: Record<string, unknown> | null, value: unknown) => {
  const options = Array.isArray(question?.options) ? (question!.options as unknown[]).filter(isRecord) : [];
  const optionLabel = (entry: unknown) => {
    const match = options.find((option) => String(option.value ?? "") === String(entry));
    return String(match?.label ?? entry ?? "");
  };
  if (Array.isArray(value)) return value.map(optionLabel).filter(Boolean).join(", ");
  if (typeof value === "object" && value !== null) return jsonPreview(value);
  if (value === undefined || value === null || value === "") return "No answer";
  return optionLabel(value);
};

export function CloudSurveyResultBlock(props: { blockId?: string; args?: unknown; result: unknown; continuing?: boolean }) {
  const disclosure = useAiToolDisclosure(() => props.blockId);
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
        value: surveyAnswerLabel(question, answers()[id]),
      };
    });
    const knownIds = new Set(knownQuestions.map((question) => question.id));
    const extraAnswers = Object.entries(answers())
      .filter(([id]) => !knownIds.has(id))
      .map(([id, value]) => ({ id, label: id, value: surveyAnswerLabel(null, value) }));
    return [...knownQuestions, ...extraAnswers].filter((row) => row.id);
  };

  return (
    <details
      class="group w-full min-w-0 text-xs"
      open={disclosure.open()}
      onToggle={(event) => disclosure.onOpenChange(event.currentTarget.open)}
    >
      <summary class="inline-flex min-h-7 max-w-full cursor-pointer list-none items-center gap-1.5 py-1 leading-none text-dimmed transition-colors hover:text-primary">
        <i class="ti ti-forms shrink-0 text-base leading-none" aria-hidden="true" />
        <span class="shrink-0 font-medium">survey</span>
        <span class="min-w-0 truncate">
          {String(survey()?.title ?? "Survey")} · {props.continuing ? "waiting" : "submitted"}
        </span>
        <i
          class="ti ti-chevron-right shrink-0 text-base leading-none opacity-60 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div class="mt-1 w-full min-w-0 rounded-md bg-zinc-100/70 px-2.5 py-2 [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
        <Show when={rows().length > 0} fallback={<p class="text-xs text-dimmed">No answers submitted.</p>}>
          <dl class="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5">
            <For each={rows()}>
              {(row) => (
                <>
                  <dt class="text-xs text-dimmed">{row.label}</dt>
                  <dd class="min-w-0 whitespace-pre-wrap text-xs text-primary">{row.value}</dd>
                </>
              )}
            </For>
          </dl>
        </Show>
      </div>
    </details>
  );
}

export function CloudTextEditorBlock(props: {
  args: unknown;
  disabled?: boolean;
  disabledLabel?: string;
  onSubmit?: (result: unknown) => void | Promise<void>;
}) {
  const editor = () => (isRecord(props.args) ? props.args : null);
  const format = () => (editor()?.format === "markdown" ? "markdown" : "plain");
  const initialContent = () => (typeof editor()?.content === "string" ? String(editor()!.content) : "");
  const [content, setContent] = createSignal(initialContent());
  const [error, setError] = createSignal<string | null>(null);
  const [submitted, setSubmitted] = createSignal(false);
  const submission = mutation.create<void, unknown>({
    mutation: async (result) => {
      if (!props.onSubmit) throw new Error("Text submission is unavailable.");
      await props.onSubmit(result);
    },
    onSuccess: () => setSubmitted(true),
    onError: (submissionError) => setError(submissionError.message || "Could not submit the text. Try again."),
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
      title: "Suggest changes",
      icon: "ti ti-message",
      confirmText: "Send feedback",
      size: "medium",
      fields: {
        feedback: {
          type: "text",
          label: "What should change?",
          placeholder: "Describe what you want to be different.",
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
        aria-label={String(editor()?.title ?? "Review text")}
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
          {content().length.toLocaleString()} / {CLOUD_AI_TEXT_EDITOR_MAX_CHARS.toLocaleString()}
        </span>
        <Show
          when={!props.disabled && !submitted() && props.onSubmit}
          fallback={<p class="ml-auto text-xs text-dimmed">{props.disabledLabel ?? "Waiting for the assistant to continue."}</p>}
        >
          <div class="ml-auto flex flex-wrap justify-end gap-2">
            <Button variant="secondary" size="sm" disabled={submission.loading()} onClick={() => void requestChanges()}>
              Suggest changes
            </Button>
            <Button variant="ai" size="sm" loading={submission.loading()} loadingLabel="Submitting" onClick={() => void submit()}>
              {String(editor()?.submitLabel ?? "Continue")}
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
  const format = () => (result()?.format === "markdown" ? "Markdown" : "Plain text");
  const state = () => (feedback() ? (props.continuing ? "revising" : "changes requested") : props.continuing ? "waiting" : "submitted");
  return (
    <details
      class="group w-full min-w-0 text-xs"
      open={disclosure.open()}
      onToggle={(event) => disclosure.onOpenChange(event.currentTarget.open)}
    >
      <summary class="inline-flex min-h-7 max-w-full cursor-pointer list-none items-center gap-1.5 py-1 leading-none text-dimmed transition-colors hover:text-primary">
        <i class="ti ti-edit shrink-0 text-base leading-none" aria-hidden="true" />
        <span class="shrink-0 font-medium">text editor</span>
        <span class="min-w-0 truncate">
          {String(editor()?.title ?? "Review text")} · {state()}
        </span>
        <i
          class="ti ti-chevron-right shrink-0 text-base leading-none opacity-60 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>
      <div class="mt-1 w-full min-w-0 rounded-md bg-zinc-100/70 px-2.5 py-2 [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
        <p class="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-dimmed">{feedback() ? "Feedback" : format()}</p>
        <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-primary">
          {feedback() || content() || "Empty text submitted."}
        </pre>
      </div>
    </details>
  );
}
