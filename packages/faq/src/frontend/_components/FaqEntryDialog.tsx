import { Button, Checkbox, dialogCore, PanelDialog, panelDialogWideOptions, SegmentedControl, TextInput, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { createStore } from "solid-js/store";
import type { CreateFaq, FaqAudience, FaqEntry, FaqTranslations } from "@/contracts";
import { faqMessages } from "../messages";

type ContentLocale = "en" | "de";
type FaqEntryDialogResult = Pick<CreateFaq, "translations" | "audience">;

type FaqEntryDialogProps = {
  title: string;
  icon: string;
  confirmText: string;
  entry?: FaqEntry;
  close: (result?: FaqEntryDialogResult) => void;
};

const FaqEntryDialog = (props: FaqEntryDialogProps) => {
  const locale = useLocale();
  const t = () => faqMessages.resolve([locale()]).t;
  const [contentLocale, setContentLocale] = createSignal<ContentLocale>("en");
  const [questionEn, setQuestionEn] = createSignal(props.entry?.translations.en?.question ?? "");
  const [answerEn, setAnswerEn] = createSignal(props.entry?.translations.en?.answer ?? "");
  const [questionDe, setQuestionDe] = createSignal(props.entry?.translations.de?.question ?? "");
  const [answerDe, setAnswerDe] = createSignal(props.entry?.translations.de?.answer ?? "");
  const [audience, setAudience] = createSignal<FaqAudience[]>(props.entry?.audience ?? ["guest", "user"]);
  const [errors, setErrors] = createStore<{
    questionEn?: string;
    answerEn?: string;
    questionDe?: string;
    answerDe?: string;
    audience?: string;
  }>({});

  const toggleAudience = (value: FaqAudience, selected: boolean) => {
    setAudience((current) => (selected ? [...current, value] : current.filter((item) => item !== value)));
    setErrors("audience", undefined);
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const english = { question: questionEn().trim(), answer: answerEn().trim() };
    const german = { question: questionDe().trim(), answer: answerDe().trim() };
    const nextErrors = {
      questionEn: english.question ? undefined : t().questionRequired,
      answerEn: english.answer ? undefined : t().answerRequired,
      questionDe: german.answer && !german.question ? t().questionRequired : undefined,
      answerDe: german.question && !german.answer ? t().answerRequired : undefined,
      audience: audience().length > 0 ? undefined : t().chooseAudience,
    };
    setErrors(nextErrors);

    if (nextErrors.questionEn || nextErrors.answerEn) {
      setContentLocale("en");
      return;
    }
    if (nextErrors.questionDe || nextErrors.answerDe) {
      setContentLocale("de");
      return;
    }
    if (nextErrors.audience) return;

    const { de: _german, ...otherTranslations } = props.entry?.translations ?? {};
    const translations: FaqTranslations = {
      ...otherTranslations,
      en: english,
      ...(german.question && german.answer ? { de: german } : {}),
    };
    props.close({ translations, audience: audience() });
  };

  return (
    <PanelDialog>
      <form class="contents" onSubmit={submit}>
        <PanelDialog.Header title={props.title} icon={props.icon} close={() => props.close()} />
        <PanelDialog.Body>
          <div class="flex flex-col items-start gap-1.5">
            <SegmentedControl<ContentLocale>
              ariaLabel={t().contentLanguage}
              value={contentLocale}
              onValueChange={setContentLocale}
              options={[
                { value: "en", label: "English" },
                { value: "de", label: "Deutsch" },
              ]}
            />
            <p class="text-xs text-dimmed">{t().contentLanguageHint}</p>
          </div>

          <Show
            when={contentLocale() === "en"}
            fallback={
              <>
                <TextInput
                  label={t().question}
                  placeholder={t().questionPlaceholderDe}
                  value={questionDe}
                  onValueChange={(value) => {
                    setQuestionDe(value);
                    setErrors("questionDe", undefined);
                  }}
                  error={errors.questionDe}
                />
                <TextInput
                  label={t().answer}
                  placeholder={t().answerPlaceholderDe}
                  value={answerDe}
                  onValueChange={(value) => {
                    setAnswerDe(value);
                    setErrors("answerDe", undefined);
                  }}
                  error={errors.answerDe}
                  multiline
                  lines={8}
                />
              </>
            }
          >
            <TextInput
              label={t().question}
              placeholder={t().questionPlaceholderEn}
              value={questionEn}
              onValueChange={(value) => {
                setQuestionEn(value);
                setErrors("questionEn", undefined);
              }}
              error={errors.questionEn}
              required
            />
            <TextInput
              label={t().answer}
              placeholder={t().answerPlaceholderEn}
              value={answerEn}
              onValueChange={(value) => {
                setAnswerEn(value);
                setErrors("answerEn", undefined);
              }}
              error={errors.answerEn}
              multiline
              lines={8}
              required
            />
          </Show>

          <fieldset class="mt-2 flex flex-col gap-2 border-0 p-0">
            <legend class="mb-1 text-sm font-medium">{t().audience}</legend>
            <Checkbox
              label={t().anonymousFull}
              description={t().anonymousDescription}
              value={() => audience().includes("anonymous")}
              onValueChange={(selected) => toggleAudience("anonymous", selected)}
            />
            <Checkbox
              label={t().guests}
              description={t().guestsDescription}
              value={() => audience().includes("guest")}
              onValueChange={(selected) => toggleAudience("guest", selected)}
            />
            <Checkbox
              label={t().fullUsers}
              description={t().usersDescription}
              value={() => audience().includes("user")}
              onValueChange={(selected) => toggleAudience("user", selected)}
            />
            <Show when={errors.audience}>
              {(error) => (
                <p class="k2b-field__error" role="alert" aria-live="polite">
                  {error()}
                </p>
              )}
            </Show>
          </fieldset>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <div class="ml-auto flex items-center gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => props.close()}>
              {t().cancel}
            </Button>
            <Button type="submit" size="sm">
              {props.confirmText}
            </Button>
          </div>
        </PanelDialog.Footer>
      </form>
    </PanelDialog>
  );
};

export const openFaqEntryDialog = (options: Omit<FaqEntryDialogProps, "close">) =>
  dialogCore.open<FaqEntryDialogResult>((close) => <FaqEntryDialog {...options} close={close} />, panelDialogWideOptions);
