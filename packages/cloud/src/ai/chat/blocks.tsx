import { dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, Chat, isStructuredDataValue, MarkdownView, SplitButton, StructuredDataPreview, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, Match, Show, Switch, untrack } from "solid-js";
import type { CapabilityActionReview } from "../../contracts/capabilities";
import { markdown } from "../../shared";
import type { AiTurnBlock } from "../protocol";
import { hasSpecializedBuiltinToolView, SpecializedBuiltinToolBlock } from "./builtin-tools";
import { hasCapabilityTable } from "./capability-result";
import { CapabilityTablePreview } from "./capability-table";
import { PresentToolBlock } from "./file-tools";
import { useAiChatActions } from "./message-actions";
import {
  aiToolIcon,
  capabilityErrorDescription,
  displayToolName,
  fetchFileErrorPresentation,
  formatToolDetailText,
  isCardToolName,
  isRecord,
  isSurveyToolName,
  isTextEditorToolName,
  jsonPreview,
  memoryToolPresentation,
} from "./message-utils";
import { aiChatMessages } from "./messages";
import { AssistantMarkdownBlock } from "./primitives";
import { AiToolActivity } from "./tool-disclosure";
import { isFailedTool } from "./tool-groups";
import { CloudCardBlock, CloudSurveyBlock, CloudSurveyResultBlock, CloudTextEditorBlock, CloudTextEditorResultBlock } from "./visual-tools";
import { FetchFileToolBlock, WebExtractToolBlock, WebSearchToolBlock } from "./web-tools";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
type ReviewDetail = NonNullable<CapabilityActionReview["details"]>[number];

const reviewDetailText = (detail: ReviewDetail, locale: string): string => {
  if (detail.format === "date")
    return /^\d{4}-\d{2}-\d{2}$/.test(detail.value)
      ? dates.formatDate(`${detail.value}T12:00:00.000Z`, { locale, timeZone: "UTC" })
      : dates.formatDate(detail.value, { locale });
  if (detail.format === "date-time") return dates.formatDateTime(detail.value, { locale });
  return detail.value;
};

function ReviewDetailValue(props: { detail: ReviewDetail }) {
  const locale = useLocale();
  const value = () => reviewDetailText(props.detail, locale());
  return (
    <Show when={props.detail.format} fallback={value()}>
      <time dateTime={props.detail.value}>{value()}</time>
    </Show>
  );
}

// All state branches below live in reactive JSX (Show/Switch), never in the
// component body: blocks are born empty/running and mutate in place while the
// turn streams, so every branch must re-evaluate when the store updates.

function ThinkingBlockView(props: { text: string; streaming?: boolean }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <Show
      when={props.text.trim()}
      fallback={
        <Show when={props.streaming}>
          <Chat.Activity label={t().thinking} icon="ti ti-sparkles" tone="ai" busy />
        </Show>
      }
    >
      <Chat.Activity label={t().showReasoning} icon="ti ti-sparkles" tone="ai" bodyInset={false}>
        <pre class="max-h-52 w-full min-w-0 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-100/70 p-2 text-[11px] leading-5 text-secondary [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
          {props.text}
        </pre>
      </Chat.Activity>
    </Show>
  );
}

export function CompactionBlockView(props: { block: Extract<AiTurnBlock, { kind: "compaction" }> }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const status = () => props.block.status;
  const description = () => {
    if (status() === "completed") return t().compacted;
    if (status() === "skipped") return t().compactionSkipped;
    if (status() === "failed") return t().compactionFailed;
    return t().compacting;
  };

  return (
    <Show when={status() !== "running"} fallback={<Chat.Activity label={t().compacting} icon="ti ti-brain" tone="ai" busy />}>
      <Chat.Activity
        label={t().showCompaction}
        description={description()}
        icon="ti ti-brain"
        tone={status() === "failed" ? "danger" : "ai"}
        bodyInset={false}
      >
        <div class="w-full min-w-0 rounded-md bg-zinc-100/70 p-2 text-[11px] leading-5 text-secondary [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
          <Show when={props.block.result} fallback={<p>{t().compactionSummary}</p>}>
            {(compactResult) => (
              <dl class="grid grid-cols-2 gap-2">
                <div class="rounded-md bg-white/65 px-2 py-1 dark:bg-white/5">
                  <dt class="uppercase tracking-wide text-dimmed">{t().before}</dt>
                  <dd class="font-medium text-primary">{compactResult().entriesBefore.toLocaleString(locale())}</dd>
                </div>
                <div class="rounded-md bg-white/65 px-2 py-1 dark:bg-white/5">
                  <dt class="uppercase tracking-wide text-dimmed">{t().after}</dt>
                  <dd class="font-medium text-primary">{compactResult().entriesAfter.toLocaleString(locale())}</dd>
                </div>
              </dl>
            )}
          </Show>
        </div>
      </Chat.Activity>
    </Show>
  );
}

function ToolTextDetail(props: { children: JSX.Element }) {
  return (
    <pre class="max-h-52 w-full min-w-0 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-100 p-2 text-[11px] leading-4 text-primary [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
      {props.children}
    </pre>
  );
}

function ToolDetail(props: { title: string; toolName: string; value: unknown }) {
  const structured = () =>
    props.toolName !== "web_search" &&
    props.toolName !== "web_extract" &&
    typeof props.value !== "string" &&
    isStructuredDataValue(props.value)
      ? { data: props.value }
      : null;

  return (
    <div class="min-w-0">
      <p class="mb-1 text-[10px] font-medium uppercase tracking-wide text-dimmed">{props.title}</p>
      <Show when={structured()} fallback={<ToolTextDetail>{formatToolDetailText(props.toolName, props.value)}</ToolTextDetail>}>
        {(value) => <StructuredDataPreview data={value().data} maxRows={8} class="w-full" />}
      </Show>
    </div>
  );
}

function ToolResultDisclosure(props: {
  blockId: string;
  name: string;
  toolName: string;
  args?: unknown;
  result: unknown;
  isError: boolean;
  icon?: string;
  accent?: string;
  labelOnError?: string;
  errorLabel?: string;
  errorDescription?: string;
}) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  return (
    <AiToolActivity
      blockId={props.blockId}
      icon={props.icon ?? (props.isError ? "ti ti-alert-circle" : aiToolIcon(props.toolName))}
      label={props.isError ? (props.errorLabel ?? t().toolFailed({ title: props.labelOnError ?? props.name })) : props.name}
      description={props.isError ? props.errorDescription : undefined}
      tone={props.isError ? "danger" : "neutral"}
      accent={props.accent}
      defaultOpen={props.isError}
      bodyInset={false}
    >
      <div class="flex w-full min-w-0 flex-col gap-2">
        <Show when={props.args !== undefined}>
          <ToolDetail title={t().input} toolName={props.toolName} value={props.args} />
        </Show>
        <ToolDetail title={t().response} toolName={props.toolName} value={props.result} />
      </div>
    </AiToolActivity>
  );
}

export function ApprovalBlockView(props: { turnId: string; block: ToolBlock }) {
  const actions = useAiChatActions();
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const request = () => ({ turnId: props.turnId, callId: props.block.callId, name: props.block.name });
  const pending = () => props.block.status === "awaiting_approval";
  const actionDisabled = () => actions.actionDisabled?.() ?? false;
  const [submitted, setSubmitted] = createSignal(false);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  const approval = mutation.create<void, { approved: boolean; remember?: "always" }>({
    mutation: async (input) => {
      if (!actions.onApproval) throw new Error("Approval is unavailable.");
      await actions.onApproval(request(), input);
    },
    onSuccess: () => setSubmitted(true),
  });
  const submit = (input: { approved: boolean; remember?: "always" }) => {
    if (!actionDisabled() && !approval.loading()) void approval.mutate(input);
  };
  const title = () => props.block.presentation?.title ?? displayToolName(props.block.name);
  const ownerName = () => props.block.presentation?.appName ?? t().assistant;
  const description = () => {
    const reviewMessage = props.block.approval?.review?.message.trim();
    if (reviewMessage) return reviewMessage;
    const message = props.block.approval?.message?.trim();
    if (!message) return null;
    const duplicateTitle = props.block.presentation ? `${props.block.presentation.appName}: ${props.block.presentation.title}` : "";
    const withoutDuplicateTitle =
      duplicateTitle && (message === duplicateTitle || message.startsWith(`${duplicateTitle}\n`))
        ? message.slice(duplicateTitle.length).trim()
        : message;
    if (/^Review the validated arguments below before running this action\.$/i.test(withoutDuplicateTitle)) return null;
    return withoutDuplicateTitle || null;
  };
  const reviewLines = () =>
    (props.block.approval?.review ? "" : (description() ?? ""))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = /^([^:]{1,40}):\s+(.+)$/.exec(line);
        return match ? { label: match[1], value: match[2] } : { value: line };
      });
  const inlineReviewDetails = () =>
    (props.block.approval?.review?.details ?? []).filter((detail) => (detail.display ?? "inline") === "inline");
  const blockReviewDetails = () => (props.block.approval?.review?.details ?? []).filter((detail) => detail.display === "block");
  const reviewLinks = () => props.block.approval?.review?.links ?? [];
  const reviewLinkTitle = (rel: "open" | "edit" | "status" | "preview" | "download") =>
    ({
      open: t().openIn({ app: ownerName() }),
      edit: t().editIn({ app: ownerName() }),
      status: t().statusIn({ app: ownerName() }),
      preview: t().preview,
      download: t().download,
    })[rel];
  const detailData = () => (isStructuredDataValue(props.block.args) ? props.block.args : undefined);
  const appAccent = () => props.block.presentation?.appAccent;
  const detailsId = `approval-details-${props.block.callId}`;
  return (
    <div class="w-full">
      <section
        class={`w-full overflow-hidden rounded-xl border border-[var(--k2b-border)] bg-[var(--k2b-surface)] text-sm text-primary ${appAccent() ? "app-accent-scope" : ""}`}
        style={{ "--app-accent": appAccent() }}
        aria-label={t().approvalRequired({ title: title() })}
      >
        <div class="p-4">
          <div class="flex min-w-0 items-center gap-3">
            <span
              class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-base leading-none"
              style={{
                color: appAccent() ? "var(--ui-app-accent-text)" : "var(--k2b-ai-accent)",
                background: appAccent()
                  ? "color-mix(in srgb, var(--app-accent) 10%, var(--k2b-surface))"
                  : "color-mix(in srgb, var(--k2b-ai-accent) 10%, var(--k2b-surface))",
              }}
              aria-hidden="true"
            >
              <i class={`${aiToolIcon(props.block.name, props.block.presentation?.appIcon)} leading-none`} />
            </span>
            <div class="min-w-0">
              <h3 class="truncate text-sm font-semibold leading-5 text-primary">
                {ownerName()} · {title()}
              </h3>
              <p class="text-xs text-dimmed">{t().action}</p>
            </div>
          </div>
          <Show when={reviewLines().length > 0}>
            <div class="mt-4 flex flex-col gap-1 text-xs leading-5 text-secondary">
              <For each={reviewLines()}>
                {(line) => (
                  <p class="whitespace-pre-wrap">
                    <Show when={line.label}>{(label) => <strong class="font-semibold text-primary">{label()}: </strong>}</Show>
                    {line.value}
                  </p>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.block.approval?.review}>
            <div class="mt-4 flex flex-col gap-4 text-xs leading-5 text-secondary">
              <p class="whitespace-pre-wrap">{description()}</p>
              <Show when={inlineReviewDetails().length > 0}>
                <dl class="grid gap-x-5 gap-y-1.5 border-t border-[var(--k2b-border)] pt-3 sm:grid-cols-[max-content_minmax(0,1fr)]">
                  <For each={inlineReviewDetails()}>
                    {(detail) => (
                      <>
                        <dt class="font-semibold text-primary">{detail.label}</dt>
                        <dd class="min-w-0 whitespace-pre-wrap break-words">
                          <ReviewDetailValue detail={detail} />
                        </dd>
                      </>
                    )}
                  </For>
                </dl>
              </Show>
              <For each={blockReviewDetails()}>
                {(detail) => (
                  <section class="min-w-0" aria-label={detail.label}>
                    <h4 class="mb-1.5 font-semibold text-primary">{detail.label}</h4>
                    <Show
                      when={detail.format === "markdown"}
                      fallback={
                        <pre
                          class="max-h-72 overflow-auto whitespace-pre-wrap break-words pr-2 font-sans text-xs leading-5 text-secondary"
                          role="region"
                          tabIndex={0}
                          aria-label={t().contentOf({ label: detail.label })}
                        >
                          <ReviewDetailValue detail={detail} />
                        </pre>
                      }
                    >
                      <div class="max-h-72 overflow-auto text-xs text-secondary" role="region" tabIndex={0} aria-label={detail.label}>
                        <MarkdownView class="cloud-ai-approval-detail" markdown={detail.value} headingScale="compact" allowImages={false} />
                      </div>
                    </Show>
                  </section>
                )}
              </For>
            </div>
          </Show>
        </div>
        <footer
          class="flex min-h-12 flex-wrap items-center gap-2 border-t border-[var(--k2b-border)] bg-[var(--k2b-surface-subtle)] px-4 py-2.5"
          data-ai-approval-footer
        >
          <Show when={reviewLinks().length > 0}>
            <nav class="flex flex-wrap gap-1" aria-label={t().linksFor({ title: title() })}>
              <For each={reviewLinks()}>
                {(link) => (
                  <ButtonLink href={link.href} target="_blank" rel="noopener noreferrer" size="xs" variant="ghost">
                    {link.title ?? reviewLinkTitle(link.rel)}
                  </ButtonLink>
                )}
              </For>
            </nav>
          </Show>
          <Show when={approval.error()}>
            <p class="text-xs text-red-700 dark:text-red-300">{t().approvalFailed}</p>
          </Show>
          <div class="ml-auto shrink-0">
            <Show
              when={pending()}
              fallback={
                <span class="text-xs font-medium text-secondary">
                  {title()} · {props.block.status === "rejected" ? t().rejected : t().approved}
                </span>
              }
            >
              <Show when={actions.onApproval} fallback={<span class="text-xs font-medium text-secondary">{t().approvalUnavailable}</span>}>
                <Show
                  when={!actionDisabled()}
                  fallback={
                    <span class="inline-flex items-center gap-1 text-xs font-medium text-secondary">
                      <i class="ti ti-player-stop" aria-hidden="true" />
                      {t().stoppingResponse}
                    </span>
                  }
                >
                  <Show
                    when={!approval.loading() && !submitted()}
                    fallback={
                      <span class="inline-flex items-center gap-1 text-xs font-medium text-secondary">
                        <i class={`ti ${submitted() ? "ti-check" : "ti-loader-2 animate-spin"}`} aria-hidden="true" />
                        {submitted() ? t().submitted : t().submitting}
                      </span>
                    }
                  >
                    <div class="flex flex-wrap justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => submit({ approved: false })}>
                        {t().reject}
                      </Button>
                      <SplitButton
                        size="xs"
                        variant="ai"
                        onClick={() => submit({ approved: true })}
                        menuLabel={t().moreOptions({ title: title() })}
                        menuPosition="bottom-right"
                        items={[
                          {
                            label: detailsOpen() ? t().hideDetails : t().details,
                            icon: detailsOpen() ? "ti ti-eye-off" : "ti ti-eye",
                            action: () => setDetailsOpen((open) => !open),
                          },
                          ...(props.block.approval?.allowAlways
                            ? [
                                {
                                  label: t().alwaysApprove,
                                  icon: "ti ti-shield-check",
                                  action: () => submit({ approved: true, remember: "always" }),
                                },
                              ]
                            : []),
                        ]}
                      >
                        {title()}
                      </SplitButton>
                    </div>
                  </Show>
                </Show>
              </Show>
            </Show>
          </div>
        </footer>
      </section>
      <Show when={detailsOpen()}>
        <div id={detailsId} class="mt-2 w-full" role="region" aria-label={t().detailsFor({ title: title() })}>
          <Show
            when={detailData()}
            fallback={
              <pre class="max-h-40 overflow-auto rounded-md bg-white/55 p-2 text-[11px] text-primary dark:bg-black/20">
                {jsonPreview(props.block.args)}
              </pre>
            }
          >
            {(data) => <StructuredDataPreview data={data()} class="w-full" />}
          </Show>
        </div>
      </Show>
    </div>
  );
}

function CapabilityToolView(props: { block: ToolBlock }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const presentation = () => props.block.presentation!;
  const label = () => presentation().title;
  const result = () => (isRecord(props.block.result) ? props.block.result : null);
  const summary = () => {
    const value = result()?.summary;
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    return trimmed.length <= 500 ? trimmed : "";
  };
  const links = () => {
    const value = result()?.links;
    return Array.isArray(value)
      ? value.filter((link) => isRecord(link) && typeof link.href === "string" && /^\/(?![\\/])[^\\\u0000-\u001f\u007f]*$/.test(link.href))
      : [];
  };
  const hasReadableResult = () => !props.block.isError && Boolean(summary());
  return (
    <>
      <Show
        when={props.block.status !== "running"}
        fallback={
          <Chat.Activity
            icon={aiToolIcon(props.block.name, presentation().appIcon)}
            label={label()}
            tone="ai"
            accent={presentation().appAccent}
            busy
          />
        }
      >
        <Show
          when={!props.block.isError}
          fallback={
            <Chat.Activity
              icon={aiToolIcon(props.block.name, presentation().appIcon)}
              label={t().toolFailed({ title: label() })}
              description={capabilityErrorDescription(props.block.result) || t().actionNotCompleted}
              tone="danger"
              accent={presentation().appAccent}
            />
          }
        >
          <Show
            when={hasReadableResult()}
            fallback={
              <ToolResultDisclosure
                blockId={props.block.id}
                name={label()}
                labelOnError={label()}
                icon={aiToolIcon(props.block.name, presentation().appIcon)}
                accent={presentation().appAccent}
                toolName={props.block.name}
                args={props.block.args}
                result={props.block.result}
                isError={Boolean(props.block.isError)}
              />
            }
          >
            <Chat.Activity
              icon={aiToolIcon(props.block.name, presentation().appIcon)}
              label={summary()}
              accent={presentation().appAccent}
              trailing={
                links().length > 0 ? (
                  <span class="flex min-w-0 flex-wrap items-center justify-end gap-1">
                    <For each={links()}>
                      {(link) => (
                        <ButtonLink
                          class="ai-chat-result-link"
                          href={String(link.href)}
                          target="_blank"
                          rel="noopener noreferrer"
                          size="xs"
                          variant="ghost"
                        >
                          {typeof link.title === "string"
                            ? link.title
                            : link.rel === "edit"
                              ? t().edit
                              : link.rel === "download"
                                ? t().download
                                : t().open}
                        </ButtonLink>
                      )}
                    </For>
                  </span>
                ) : undefined
              }
            />
          </Show>
        </Show>
      </Show>
    </>
  );
}

function RejectedToolView(props: { block: ToolBlock }) {
  const locale = useLocale();
  const presentation = () => props.block.presentation;
  const title = () => presentation()?.title ?? displayToolName(props.block.name);
  return (
    <Chat.Activity
      icon={aiToolIcon(props.block.name, presentation()?.appIcon)}
      label={aiChatMessages(locale()).toolRejected({ title: title() })}
      accent={presentation()?.appAccent}
    />
  );
}

export function SurveyToolView(props: { turnId: string; block: ToolBlock; active?: boolean }) {
  const actions = useAiChatActions();
  const locale = useLocale();
  const request = () => ({ turnId: props.turnId, callId: props.block.callId, name: props.block.name });
  const submit = actions.onFrontendToolResult;
  const submittedResult = () =>
    props.block.status === "completed" && isRecord(props.block.result) && props.block.result.submitted === true ? props.block.result : null;
  return (
    <Switch fallback={<CloudSurveyBlock args={props.block.args} disabled />}>
      <Match when={props.block.status === "awaiting_client"}>
        <CloudSurveyBlock
          args={props.block.args}
          disabled={!submit || actions.actionDisabled?.()}
          disabledLabel={actions.actionDisabled?.() ? aiChatMessages(locale()).stoppingResponse : undefined}
          onSubmit={submit ? (result) => submit(request(), result) : undefined}
        />
      </Match>
      <Match when={submittedResult()}>
        {(result) => (
          // biome-ignore lint/a11y/useValidAriaRole: Chat.Message uses a conversation role, not an ARIA role.
          <Chat.Message role="user">
            <CloudSurveyResultBlock args={props.block.args} result={result()} />
          </Chat.Message>
        )}
      </Match>
    </Switch>
  );
}

export function TextEditorToolView(props: { turnId: string; block: ToolBlock; active?: boolean }) {
  const actions = useAiChatActions();
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const request = () => ({ turnId: props.turnId, callId: props.block.callId, name: props.block.name });
  const submit = actions.onFrontendToolResult;
  const completedResult = () =>
    props.block.status === "completed" &&
    isRecord(props.block.result) &&
    ((props.block.result.submitted === true && typeof props.block.result.content === "string") ||
      (props.block.result.submitted === false && typeof props.block.result.feedback === "string"))
      ? props.block.result
      : null;
  return (
    <Switch
      fallback={
        <ToolResultDisclosure
          blockId={props.block.id}
          name={t().textEditor}
          toolName={props.block.name}
          args={props.block.args}
          result={props.block.result}
          isError={Boolean(props.block.isError)}
        />
      }
    >
      <Match when={props.block.status === "running"}>
        <Chat.Activity label={t().preparingTextEditor} icon="ti ti-edit" tone="ai" busy />
      </Match>
      <Match when={props.block.status === "awaiting_client"}>
        <CloudTextEditorBlock
          args={props.block.args}
          disabled={!submit || actions.actionDisabled?.()}
          disabledLabel={actions.actionDisabled?.() ? t().stoppingResponse : undefined}
          onSubmit={submit ? (result) => submit(request(), result) : undefined}
        />
      </Match>
      <Match when={completedResult()}>
        {(result) => (
          <CloudTextEditorResultBlock blockId={props.block.id} args={props.block.args} result={result()} continuing={props.active} />
        )}
      </Match>
    </Switch>
  );
}

function MemoryToolView(props: { block: ToolBlock }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const presentation = () => memoryToolPresentation(props.block.args, props.block.result, locale());
  return (
    <Show when={props.block.status !== "running"} fallback={<Chat.Activity label={t().usingMemory} icon="ti ti-brain" tone="ai" busy />}>
      <Show
        when={presentation()}
        fallback={
          <ToolResultDisclosure
            blockId={props.block.id}
            name={t().memory}
            toolName={props.block.name}
            args={props.block.args}
            result={props.block.result}
            isError={Boolean(props.block.isError)}
          />
        }
      >
        {(item) => (
          <Chat.Activity
            icon={`ti ${item().failed ? "ti-alert-circle" : "ti-brain"}`}
            label={item().label}
            description={item().description}
            tone={item().failed ? "danger" : "ai"}
          />
        )}
      </Show>
    </Show>
  );
}

function ToolBlockView(props: { turnId: string; block: ToolBlock; active?: boolean }) {
  const actions = useAiChatActions();
  const locale = useLocale();
  const status = () => props.block.status;
  const fetchError = () =>
    props.block.name === "fetch_file" && props.block.isError ? fetchFileErrorPresentation(props.block.result, locale()) : undefined;
  return (
    <>
      <Switch
        fallback={
          <ToolResultDisclosure
            blockId={props.block.id}
            name={displayToolName(props.block.name)}
            toolName={props.block.name}
            args={props.block.args}
            result={props.block.result}
            isError={Boolean(props.block.isError)}
            errorLabel={fetchError()?.label}
            errorDescription={fetchError()?.description}
          />
        }
      >
        <Match when={status() === "awaiting_approval"}>
          <ApprovalBlockView turnId={props.turnId} block={props.block} />
        </Match>
        <Match when={status() === "rejected"}>
          <RejectedToolView block={props.block} />
        </Match>
        <Match when={props.block.presentation?.kind === "capability"}>
          <CapabilityToolView block={props.block} />
        </Match>
        <Match
          when={actions.renderCodePresentation && props.block.name === "code_present" && status() === "completed" && !props.block.isError}
        >
          {untrack(() => actions.renderCodePresentation?.(() => props.block.result))}
        </Match>
        <Match when={props.block.name === "present" && !props.block.isError}>
          <PresentToolBlock block={props.block} />
        </Match>
        <Match when={props.block.name === "web_search" && !props.block.isError}>
          <WebSearchToolBlock block={props.block} />
        </Match>
        <Match when={props.block.name === "web_extract" && !props.block.isError}>
          <WebExtractToolBlock block={props.block} />
        </Match>
        <Match when={props.block.name === "fetch_file" && !props.block.isError}>
          <FetchFileToolBlock block={props.block} />
        </Match>
        <Match when={props.block.name === "memory"}>
          <MemoryToolView block={props.block} />
        </Match>
        <Match
          when={hasSpecializedBuiltinToolView(props.block.name, props.block.result) && status() === "completed" && !props.block.isError}
        >
          <SpecializedBuiltinToolBlock block={props.block} />
        </Match>
        <Match when={isCardToolName(props.block.name) && !props.block.isError}>
          <CloudCardBlock args={props.block.args} />
        </Match>
        <Match when={isSurveyToolName(props.block.name) && !props.block.isError}>
          <SurveyToolView turnId={props.turnId} block={props.block} active={props.active} />
        </Match>
        <Match when={isTextEditorToolName(props.block.name)}>
          <TextEditorToolView turnId={props.turnId} block={props.block} active={props.active} />
        </Match>
        <Match when={status() === "running" || status() === "awaiting_client"}>
          <Chat.Activity label={displayToolName(props.block.name)} icon={aiToolIcon(props.block.name)} busy />
        </Match>
      </Switch>
      <Show when={hasCapabilityTable(props.block)}>
        <CapabilityTablePreview result={props.block.result} label={props.block.presentation?.title ?? displayToolName(props.block.name)} />
      </Show>
    </>
  );
}

/** Render one unified turn block. Shared by persisted assistant groups and the live turn. */
export function AiTurnBlockView(props: { block: AiTurnBlock; turnId: string; streaming?: boolean; active?: boolean }) {
  const locale = useLocale();
  // The id/kind remain stable while the immutable block value changes during a turn.
  return (
    <Switch>
      <Match when={props.block.kind === "text" && props.block}>
        {(block) => <AssistantMarkdownBlock html={markdown.renderSync(block().text, { locale: locale() })} />}
      </Match>
      <Match when={props.block.kind === "thinking" && props.block}>
        {(block) => <ThinkingBlockView text={block().text} streaming={props.streaming} />}
      </Match>
      <Match when={props.block.kind === "steer_applied"}>
        <Chat.Activity label={aiChatMessages(locale()).conversationSteered} icon="ti ti-route" tone="ai" />
      </Match>
      <Match when={props.block.kind === "tool" && props.block}>
        {(block) => <ToolBlockView turnId={props.turnId} block={block()} active={props.active} />}
      </Match>
      <Match when={props.block.kind === "compaction" && props.block}>{(block) => <CompactionBlockView block={block()} />}</Match>
    </Switch>
  );
}

/** One step in the expanded work list: its title, target, and state, with input and output on demand. */
export function CompactToolRow(props: { block: ToolBlock; busy?: boolean }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  const detail = () => [args().path, args().name, args().query, args().title].find((value) => typeof value === "string");
  const waiting = () => props.block.status === "awaiting_client" || props.block.status === "awaiting_approval";
  const state = () =>
    waiting() ? t().stepWaiting : props.block.status === "rejected" ? t().stepRejected : isFailedTool(props.block) ? t().stepFailed : "";
  return (
    <AiToolActivity
      blockId={props.block.id}
      label={props.block.presentation?.title ?? displayToolName(props.block.name)}
      description={[
        props.block.status === "running" ? (props.block.progress ?? "") : "",
        typeof detail() === "string" ? String(detail()) : "",
        state(),
      ]
        .filter(Boolean)
        .join(" · ")}
      icon={waiting() ? "ti ti-clock" : aiToolIcon(props.block.name, props.block.presentation?.appIcon)}
      busy={props.busy && props.block.status === "running"}
      renderBody={() => (
        <div
          class="max-h-72 overflow-auto overscroll-contain rounded-md bg-zinc-100 p-3 dark:bg-zinc-950"
          tabIndex={0}
          role="region"
          aria-label={t().toolInputOutput}
        >
          <ToolDetail title={t().input} toolName={props.block.name} value={props.block.args} />
          <ToolDetail title={t().output} toolName={props.block.name} value={props.block.result} />
        </div>
      )}
    />
  );
}
