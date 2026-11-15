import { NoticeCard, Section, useLocale } from "@k2b/ui";
import { For, Match, Show, Switch } from "solid-js";
import type { AiTurnBlock } from "../protocol";
import { type CodeStepWords, codeStepWords } from "./code-step-words";
import { isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";
import { submittedCodeVersion } from "./turn-layout";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/**
 * Lasting Code steps. The person sees what a step did in words: never source, a file, a line, a diagnostic code or an
 * ID. Core adds `words` to the results of check, test and simulate; the model keeps the exact data beside them.
 */
const CODE_STEP_TOOLS: ReadonlySet<string> = new Set([
  "code_init",
  "code_pull",
  "code_read",
  "code_sdk",
  "code_write",
  "code_check",
  "code_test",
  "code_simulate",
  "code_submit",
  "code_diff",
  "code_review",
]);
export const hasCodeStepView = (name: string): boolean => CODE_STEP_TOOLS.has(name);

/** Core answers a refused or failed command with `{ error: { code, message } }`; only its message is for people. */
const failureMessage = (block: ToolBlock): string | null => {
  const result = block.result;
  if (isRecord(result) && isRecord(result.error) && typeof result.error.message === "string") return result.error.message;
  return null;
};

/** One sentence for a finished step, inside the open work line. */
export function CodeStepBody(props: { block: ToolBlock }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const words = () => codeStepWords(props.block);
  const version = () => submittedCodeVersion(props.block);
  const failed = () => (props.block.isError || failureMessage(props.block) !== null) && props.block.status === "completed";
  return (
    <div class="ai-code-step">
      <Switch>
        <Match when={failed()}>
          <p class="ai-code-step__note" data-tone="danger" role="status">
            <i class="ti ti-alert-circle" aria-hidden="true" />
            <span>{t().codeStepFailed}</span>
          </p>
        </Match>
        <Match when={props.block.name === "code_check" && words()}>
          {(current) => (
            <Show
              when={(current().mayDo?.length ?? 0) > 0}
              fallback={
                <p class="ai-code-step__note">
                  {current().notices.length ? t().codeStepNotices({ count: current().notices.length }) : t().codeStepNoNotices}
                </p>
              }
            >
              <ul class="ai-code-step__list" aria-label={t().codeStepMayDo}>
                <For each={current().mayDo}>
                  {(item) => (
                    <li class="ai-code-step__item">
                      <i class="ti ti-key" aria-hidden="true" />
                      <span class="ai-code-step__text">{item.text}</span>
                      <Show when={item.isNew}>
                        <span class="ai-code-step__mark">{t().codeStepNew}</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Match>
        <Match when={(props.block.name === "code_test" || props.block.name === "code_simulate") && words()}>
          {(current) => <p class="ai-code-step__note">{current().examples?.summary ?? t().codeStepNoExamples}</p>}
        </Match>
        <Match when={props.block.name === "code_submit" && version()}>
          {(submitted) => <p class="ai-code-step__note">{t().codeStepSubmitted({ number: submitted().number })}</p>}
        </Match>
      </Switch>
    </div>
  );
}

/** Notices with their consequence, each as one calm card in the conversation. */
function CodeNotices(props: { notices: CodeStepWords["notices"] }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <div class="ai-code-notices">
      <For each={props.notices}>
        {(notice) => (
          <NoticeCard
            tone={notice.severity === "block" ? "danger" : "warning"}
            icon={notice.severity === "block" ? "ti ti-ban" : "ti ti-alert-triangle"}
            layout="card"
            title={notice.text}
            detail={t().codeStepConsequence({ consequence: notice.consequence })}
          />
        )}
      </For>
    </div>
  );
}

/**
 * Tried examples as one topic: what an example is, then each one with its name, its result word and what it did. A
 * failed example says what Gustav expected and what happened. The result word keeps one width, so the text beside it
 * never reflows when "Running" becomes "Successful".
 */
function CodeExamples(props: { examples: NonNullable<CodeStepWords["examples"]>; trial: boolean }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <Section
      class="ai-code-examples"
      title={props.trial ? t().codeStepTrial : t().codeStepExamples}
      meta={t().codeStepExamplesCount({ passed: props.examples.passed, total: props.examples.total })}
      description={props.examples.explanation}
    >
      <ul class="ai-code-examples__list" aria-label={props.trial ? t().codeStepTrial : t().codeStepExamples}>
        <For each={props.examples.items}>
          {(example) => (
            <li class="ai-code-examples__item" data-state={example.state}>
              <i class={example.state === "succeeded" ? "ti ti-circle-check" : "ti ti-circle-x"} aria-hidden="true" />
              <span class="ai-code-examples__name">{example.name}</span>
              <span class="ai-code-examples__status">{example.status}</span>
              <span class="ai-code-examples__sentence">{example.sentence}</span>
              <Show when={example.state === "failed" && example.differences.length > 0}>
                <dl class="ai-code-examples__differences">
                  <For each={example.differences}>
                    {(difference) => (
                      <>
                        <dt>{t().codeStepExpected}</dt>
                        <dd>{difference.expected}</dd>
                        <dt>{t().codeStepHappened}</dt>
                        <dd>{difference.actual}</dd>
                      </>
                    )}
                  </For>
                </dl>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Section>
  );
}

/** What a finished check, test or simulation shows in the conversation: notices first, then the tried examples. */
export function CodeStepResult(props: { block: ToolBlock }) {
  const words = () => {
    const current = codeStepWords(props.block);
    return current && (current.notices.length > 0 || current.examples) ? current : null;
  };
  return (
    <Show when={words()}>
      {(current) => (
        <div class="ai-code-result">
          <Show when={current().notices.length > 0}>
            <CodeNotices notices={current().notices} />
          </Show>
          <Show when={current().examples}>
            {(examples) => <CodeExamples examples={examples()} trial={props.block.name === "code_simulate"} />}
          </Show>
        </div>
      )}
    </Show>
  );
}
