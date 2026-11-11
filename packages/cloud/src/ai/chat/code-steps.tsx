import { CodeDisplay, type CodeDisplayLanguage, StatusBadge, useLocale } from "@k2b/ui";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import type { AiTurnBlock } from "../protocol";
import { isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";
import { submittedCodeVersion } from "./turn-layout";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
type Finding = { code: string; message: string; file: string; line: number };
type Permission = {
  operation: string;
  title: string | null;
  typeTitle: string | null;
  status: "new" | "existing";
  file: string;
  line: number;
};

/** Lasting Code steps that read as source, findings, test cases or files instead of their JSON. */
const CODE_STEP_TOOLS: ReadonlySet<string> = new Set([
  "code_init",
  "code_pull",
  "code_read",
  "code_write",
  "code_check",
  "code_test",
  "code_simulate",
  "code_submit",
]);
export const hasCodeStepView = (name: string): boolean => CODE_STEP_TOOLS.has(name);

const languageOf = (path: string): CodeDisplayLanguage =>
  path.endsWith(".tsx") ? "tsx" : path.endsWith(".ts") ? "ts" : path.endsWith(".jsx") ? "jsx" : path.endsWith(".js") ? "js" : "text";

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Core answers a refused or failed command with `{ error: { code, message } }`; a failed call may carry plain text. */
const failureMessage = (block: ToolBlock): string | null => {
  const result = block.result;
  if (isRecord(result) && isRecord(result.error) && typeof result.error.message === "string") return result.error.message;
  return block.isError && typeof result === "string" ? result : null;
};

const findings = (value: unknown): Finding[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        isRecord(item) && typeof item.message === "string" && typeof item.file === "string" && typeof item.line === "number"
          ? [{ code: text(item.code) ?? "", message: item.message, file: item.file, line: item.line }]
          : [],
      )
    : [];

const permissions = (value: unknown): Permission[] =>
  Array.isArray(value)
    ? value.flatMap((item) =>
        isRecord(item) && typeof item.operation === "string" && typeof item.file === "string" && typeof item.line === "number"
          ? [
              {
                operation: item.operation,
                title: text(item.title),
                typeTitle: text(item.typeTitle),
                status: item.status === "existing" ? ("existing" as const) : ("new" as const),
                file: item.file,
                line: item.line,
              },
            ]
          : [],
      )
    : [];

const lineCount = (source: string) => (source ? source.split("\n").length - (source.endsWith("\n") ? 1 : 0) : 0);

/** One file's source, scrolling inside the step at a fixed height. */
function CodeSource(props: { path: string; content: string }) {
  return (
    <div class="ai-code-step__source">
      <CodeDisplay title={props.path} code={props.content} language={languageOf(props.path)} />
    </div>
  );
}

function FindingList(props: { items: Finding[]; tone: "error" | "warning"; label: string }) {
  return (
    <ul class="ai-code-step__list" aria-label={props.label}>
      <For each={props.items}>
        {(item) => (
          <li class="ai-code-step__item" data-tone={props.tone}>
            <i class={props.tone === "error" ? "ti ti-alert-circle" : "ti ti-alert-triangle"} aria-hidden="true" />
            <span class="ai-code-step__text">
              <span>{item.message}</span>
              <span class="ai-code-step__where">
                {item.file}:{item.line}
                {item.code ? ` · ${item.code}` : ""}
              </span>
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

function PermissionList(props: { items: Permission[] }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <ul class="ai-code-step__list" aria-label={t().codeStepPermissions}>
      <For each={props.items}>
        {(item) => (
          <li class="ai-code-step__item">
            <i class="ti ti-key" aria-hidden="true" />
            <span class="ai-code-step__text">
              <span>
                <code>{item.operation}</code>
                {[item.typeTitle, item.title].filter(Boolean).length ? ` · ${[item.typeTitle, item.title].filter(Boolean).join(" ")}` : ""}
              </span>
              <span class="ai-code-step__where">
                {item.file}:{item.line}
              </span>
            </span>
            <StatusBadge
              variant="text"
              tone={item.status === "new" ? "info" : "neutral"}
              icon={null}
              label={item.status === "new" ? t().codeStepPermissionNew : t().codeStepPermissionExisting}
            />
          </li>
        )}
      </For>
    </ul>
  );
}

function StepSection(props: { title: string; children: JSX.Element }) {
  return (
    <div class="ai-code-step__section">
      <p class="ai-code-step__heading">{props.title}</p>
      {props.children}
    </div>
  );
}

function CheckView(props: { result: Record<string, unknown> }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const check = () => (isRecord(props.result.result) ? props.result.result : {});
  const errors = () => findings(check().diagnostics);
  const warnings = () => findings(check().warnings);
  const rights = () => permissions(props.result.permissions);
  return (
    <>
      <Show when={errors().length || warnings().length} fallback={<p class="ai-code-step__note">{t().codeStepNoFindings}</p>}>
        <Show when={errors().length}>
          <StepSection title={t().codeStepFindings}>
            <FindingList items={errors()} tone="error" label={t().codeStepFindings} />
          </StepSection>
        </Show>
        <Show when={warnings().length}>
          <StepSection title={t().codeStepWarnings}>
            <FindingList items={warnings()} tone="warning" label={t().codeStepWarnings} />
          </StepSection>
        </Show>
      </Show>
      <Show when={rights().length}>
        <StepSection title={t().codeStepPermissions}>
          <PermissionList items={rights()} />
        </StepSection>
      </Show>
    </>
  );
}

type Case = { name: string; file: string | null; ok: boolean; failures: string[] };
const cases = (value: unknown): Case[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (!isRecord(item) || typeof item.name !== "string" || typeof item.ok !== "boolean") return [];
        const runs = Array.isArray(item.runs) ? item.runs.filter(isRecord) : [];
        // A run can execute fine and still miss its expectations: a failed case names each run's error and failed
        // assertion paths, whatever the run's own `ok`; a passing case shows none, also not an expected error.
        const failures = item.ok
          ? []
          : runs.flatMap((run) => {
              const paths = Array.isArray(run.failures) ? run.failures.filter((path) => typeof path === "string") : [];
              if (run.ok === true && paths.length === 0) return [];
              return [[text(run.entrypoint), run.ok === true ? null : text(run.error), paths.join(", ")].filter(Boolean).join(" · ")];
            });
        return [{ name: item.name, file: text(item.file), ok: item.ok, failures }];
      })
    : [];

function TestView(props: { result: Record<string, unknown> }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const all = () => cases(props.result.cases);
  const passed = () => all().filter((item) => item.ok).length;
  const problems = () => findings(props.result.diagnostics);
  const error = () => text(props.result.error);
  return (
    <>
      <Show
        when={all().length}
        fallback={
          <Show when={error()} fallback={<p class="ai-code-step__note">{t().codeStepNoCases}</p>}>
            {(code) => (
              <p class="ai-code-step__failure">
                <i class="ti ti-alert-circle" aria-hidden="true" />
                <span class="ai-code-step__text">
                  <span>{t().codeStepTestsFailed}</span>
                  <span class="ai-code-step__where">{code()}</span>
                </span>
              </p>
            )}
          </Show>
        }
      >
        <StepSection title={t().codeStepCases({ passed: passed(), total: all().length })}>
          <ul class="ai-code-step__list" aria-label={t().codeStepCases({ passed: passed(), total: all().length })}>
            <For each={all()}>
              {(item) => (
                <li class="ai-code-step__item" data-tone={item.ok ? "ok" : "error"}>
                  <i class={item.ok ? "ti ti-circle-check" : "ti ti-circle-x"} aria-hidden="true" />
                  <span class="ai-code-step__text">
                    <span>{item.name}</span>
                    <Show when={item.file || item.failures.length}>
                      <span class="ai-code-step__where">{[item.file, ...item.failures].filter(Boolean).join(" · ")}</span>
                    </Show>
                  </span>
                  <StatusBadge
                    variant="text"
                    tone={item.ok ? "ok" : "error"}
                    icon={null}
                    label={item.ok ? t().checkPassed : t().stepFailed}
                  />
                </li>
              )}
            </For>
          </ul>
        </StepSection>
      </Show>
      <Show when={problems().length}>
        <StepSection title={t().codeStepFindings}>
          <FindingList items={problems()} tone="error" label={t().codeStepFindings} />
        </StepSection>
      </Show>
    </>
  );
}

/** The files of a Code project or draft, with their size in lines. */
function FileList(props: { files: { path: string; lines: number | null }[] }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <StepSection title={t().codeStepFiles({ count: props.files.length })}>
      <ul class="ai-code-step__list" aria-label={t().codeStepFiles({ count: props.files.length })}>
        <For each={props.files}>
          {(file) => (
            <li class="ai-code-step__item">
              <i class={file.path.startsWith("test/") ? "ti ti-test-pipe" : "ti ti-file-code"} aria-hidden="true" />
              <span class="ai-code-step__text">
                <code>{file.path}</code>
              </span>
              <Show when={file.lines !== null}>
                <span class="ai-code-step__where">{t().codeStepLines({ count: file.lines ?? 0 })}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </StepSection>
  );
}

const projectFiles = (result: unknown) => {
  const files = isRecord(result) && isRecord(result.files) ? result.files : null;
  return files
    ? Object.entries(files)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([path, source]) => ({ path, lines: lineCount(source) }))
        .sort((a, b) => a.path.localeCompare(b.path))
    : [];
};

/**
 * What a lasting Code step did, in readable form: the file Gustav wrote, the checker's
 * findings and the rights the Code needs, the test cases, or the project's files. A refusal shows Core's message.
 */
export function CodeStepBody(props: { block: ToolBlock; raw: () => JSX.Element }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const result = () => (isRecord(props.block.result) ? props.block.result : null);
  const failure = () => failureMessage(props.block);
  const finished = () => props.block.status === "completed" && !failure();
  const path = () => text(args().path);
  const content = () => text(args().content);
  const version = () => submittedCodeVersion(props.block);
  return (
    <div class="ai-code-step">
      <Show when={props.block.name === "code_write" && path()}>
        {(file) => (
          <Switch>
            <Match when={content() !== null}>
              <CodeSource path={file()} content={content() ?? ""} />
            </Match>
            <Match when={text(args().renameTo)}>
              {(target) => <p class="ai-code-step__note">{t().codeStepRenamed({ from: file(), to: target() })}</p>}
            </Match>
            <Match when={args().delete === true}>
              <p class="ai-code-step__note">{t().codeStepDeleted({ path: file() })}</p>
            </Match>
          </Switch>
        )}
      </Show>
      <Show when={failure()}>
        {(message) => (
          <p class="ai-code-step__failure" role="status">
            <i class="ti ti-alert-circle" aria-hidden="true" />
            <span>{message()}</span>
          </p>
        )}
      </Show>
      <Show when={finished() && result()}>
        {(value) => (
          <Switch>
            <Match when={props.block.name === "code_check"}>
              <CheckView result={value()} />
            </Match>
            <Match when={props.block.name === "code_test" || props.block.name === "code_simulate"}>
              <TestView result={value()} />
            </Match>
            <Match when={["code_init", "code_pull", "code_read"].includes(props.block.name)}>
              <FileList files={projectFiles(value())} />
            </Match>
            <Match when={props.block.name === "code_submit" && version()}>
              {(submitted) => <p class="ai-code-step__note">{t().codeStepSubmitted({ number: submitted().number })}</p>}
            </Match>
          </Switch>
        )}
      </Show>
      {/* The exact call and result stay one click away, such as a simulation's returned value and its ordered calls. */}
      <Show when={props.block.status !== "running"}>
        <details class="ai-code-step__raw">
          <summary class="focus-ui">{t().codeStepRaw}</summary>
          {props.raw()}
        </details>
      </Show>
    </div>
  );
}
