import { dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, Chat, isStructuredDataValue, MarkdownView, SplitButton, StructuredDataPreview, useLocale } from "@k2b/ui";
import { createSignal, createUniqueId, For, type JSX, Match, Show, Switch, untrack } from "solid-js";
import { capabilityApprovalReason, capabilityApprovalReasonLabel } from "../../_internal/capability-sentences";
import type { CapabilityActionReview } from "../../contracts/capabilities";
import { markdown } from "../../shared";
import type { AiTurnBlock } from "../protocol";
import { toolOutcome, toolSubject } from "./action-sentences";
import { hasSpecializedBuiltinToolView, SpecializedBuiltinToolBlock } from "./builtin-tools";
import { hasCapabilityTable } from "./capability-result";
import { CapabilityTablePreview } from "./capability-table";
import { PresentToolBlock } from "./file-tools";
import { useAiChatActions } from "./message-actions";
import {
  aiToolIcon,
  capabilityErrorDescription,
  codeCheckOutcome,
  displayToolName,
  fetchFileErrorPresentation,
  formatToolDetailText,
  isCardToolName,
  isRecord,
  isSurveyToolName,
  isTextEditorToolName,
  jsonPreview,
  memoryToolPresentation,
  viewedChatImage,
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

/** A decision the server accepted, for the call it answered. */
export type AiApprovalDecision = { callId: string; approved: boolean };

/**
 * The pending approval: a calm tinted card that says what will happen, with its fields and the decision. `onDecided`
 * hears an accepted decision with the call it answered, so the turn can show its receipt in the card's place right away.
 */
export function ApprovalBlockView(props: { turnId: string; block: ToolBlock; onDecided?: (decision: AiApprovalDecision) => void }) {
  const actions = useAiChatActions();
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const request = () => ({ turnId: props.turnId, callId: props.block.callId, name: props.block.name });
  const pending = () => props.block.status === "awaiting_approval";
  const actionDisabled = () => actions.actionDisabled?.() ?? false;
  const [submitted, setSubmitted] = createSignal(false);
  const [detailsOpen, setDetailsOpen] = createSignal(false);
  // The call this card answered: a later approval for the same block may already have arrived when the server accepts.
  let decision: AiApprovalDecision | null = null;
  const approval = mutation.create<void, { approved: boolean; remember?: "always" }>({
    mutation: async (input) => {
      if (!actions.onApproval) throw new Error("Approval is unavailable.");
      await actions.onApproval(request(), input);
    },
    onSuccess: () => {
      setSubmitted(true);
      if (decision) props.onDecided?.(decision);
    },
  });
  const submit = (input: { approved: boolean; remember?: "always" }) => {
    if (actionDisabled() || approval.loading()) return;
    decision = { callId: props.block.callId, approved: input.approved };
    void approval.mutate(input);
  };
  // The heading says what will happen in the owning app's words; the app or the assistant name stays beside it.
  const title = () => toolSubject(props.block, locale()) ?? props.block.presentation?.title ?? displayToolName(props.block.name, locale());
  const ownerName = () => props.block.presentation?.appName ?? t().assistant;
  const capability = () => props.block.presentation?.kind === "capability";
  // The model's own reason, labelled as such, only where Cloud offered it; it adds to the app's sentence and never replaces it.
  const reason = () => (props.block.presentation?.approvalReason ? capabilityApprovalReason(props.block.args) : null);
  const description = () => {
    const reviewMessage = props.block.approval?.review?.message.trim();
    if (reviewMessage) return reviewMessage;
    // An app Action's approval text repeats its heading and reason for text-only readers; the card shows them itself.
    if (capability()) return null;
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
  const detailsId = `approval-details-${props.block.callId}`;
  return (
    <section class="ai-approval" aria-label={t().approvalRequired({ title: title() })}>
      <div class="ai-approval__head">
        <i class={`ai-approval__icon ${aiToolIcon(props.block.name, props.block.presentation?.appIcon)}`} aria-hidden="true" />
        <div class="min-w-0">
          <h3 class="ai-approval__title">{title()}</h3>
          <p class="ai-approval__sub">
            {ownerName()} · {t().approvalRunsAfter}
          </p>
        </div>
      </div>
      <Show when={reviewLines().length > 0}>
        <div class="ai-approval__text">
          <For each={reviewLines()}>
            {(line) => (
              <p class="whitespace-pre-wrap">
                <Show when={line.label}>{(label) => <strong class="ai-approval__label">{label()}: </strong>}</Show>
                {line.value}
              </p>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.block.approval?.review}>
        <p class="ai-approval__text whitespace-pre-wrap">{description()}</p>
        <Show when={inlineReviewDetails().length > 0}>
          <dl class="ai-approval__fields">
            <For each={inlineReviewDetails()}>
              {(detail) => (
                <>
                  <dt>{detail.label}</dt>
                  <dd class="whitespace-pre-wrap">
                    <ReviewDetailValue detail={detail} />
                  </dd>
                </>
              )}
            </For>
          </dl>
        </Show>
        <For each={blockReviewDetails()}>
          {(detail) => (
            <section class="ai-approval__text min-w-0" aria-label={detail.label}>
              <h4 class="ai-approval__label mb-1">{detail.label}</h4>
              <Show
                when={detail.format === "markdown"}
                fallback={
                  <pre
                    class="ai-approval__preview whitespace-pre-wrap break-words font-sans"
                    role="region"
                    tabIndex={0}
                    aria-label={t().contentOf({ label: detail.label })}
                  >
                    <ReviewDetailValue detail={detail} />
                  </pre>
                }
              >
                <div class="ai-approval__preview" role="region" tabIndex={0} aria-label={detail.label}>
                  <MarkdownView class="cloud-ai-approval-detail" markdown={detail.value} headingScale="compact" allowImages={false} />
                </div>
              </Show>
            </section>
          )}
        </For>
      </Show>
      <Show when={reason()}>
        {(text) => (
          <p class="ai-approval__text whitespace-pre-wrap">
            <strong class="ai-approval__label">{capabilityApprovalReasonLabel(locale())}: </strong>
            {text()}
          </p>
        )}
      </Show>
      <Show when={detailsOpen()}>
        <div id={detailsId} class="w-full min-w-0" role="region" aria-label={t().detailsFor({ title: title() })}>
          <Show when={detailData()} fallback={<pre class="ai-approval__preview text-[11px]">{jsonPreview(props.block.args)}</pre>}>
            {(data) => <StructuredDataPreview data={data()} class="w-full" />}
          </Show>
        </div>
      </Show>
      {/* The decision continues the card below its content: spacing, not a line or a band, sets it apart. */}
      <footer class="ai-approval__foot" data-ai-approval-footer>
        {/* Present from the start, so screen readers announce progress after the decision buttons leave. */}
        <span class="k2b-sr-only" role="status" aria-live="polite">
          {approval.loading() ? t().submitting : submitted() ? t().submitted : ""}
        </span>
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
          <p class="text-xs text-red-700 dark:text-red-300" role="alert">
            {t().approvalFailed}
          </p>
        </Show>
        <div class="ai-approval__actions">
          <Show
            when={pending()}
            fallback={
              <span class="ai-approval__state">
                {title()} · {props.block.status === "rejected" ? t().rejected : t().approved}
              </span>
            }
          >
            <Show when={actions.onApproval} fallback={<span class="ai-approval__state">{t().approvalUnavailable}</span>}>
              <Show
                when={!actionDisabled()}
                fallback={
                  <span class="ai-approval__state">
                    <i class="ti ti-player-stop" aria-hidden="true" />
                    {t().stoppingResponse}
                  </span>
                }
              >
                <Show
                  when={!submitted()}
                  fallback={
                    <span class="ai-approval__state">
                      <i class="ti ti-check" aria-hidden="true" />
                      {t().submitted}
                    </span>
                  }
                >
                  {/* The buttons stay while the decision is sent, so the card does not change its height before it
                      becomes its receipt. */}
                  <Button size="sm" variant="ghost" disabled={approval.loading()} onClick={() => submit({ approved: false })}>
                    {t().reject}
                  </Button>
                  <SplitButton
                    size="sm"
                    variant="ai"
                    loading={approval.loading()}
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
                </Show>
              </Show>
            </Show>
          </Show>
        </div>
      </footer>
    </section>
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
  const title = () => toolSubject(props.block, locale()) ?? presentation()?.title ?? displayToolName(props.block.name, locale());
  return (
    <Chat.Activity
      icon={aiToolIcon(props.block.name, presentation()?.appIcon)}
      label={toolOutcome(props.block, "rejected", locale()) ?? aiChatMessages(locale()).toolRejected({ title: title() })}
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
            name={displayToolName(props.block.name, locale())}
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
          <Chat.Activity label={displayToolName(props.block.name, locale())} icon={aiToolIcon(props.block.name)} busy />
        </Match>
      </Switch>
      <Show when={hasCapabilityTable(props.block)}>
        <CapabilityTablePreview
          result={props.block.result}
          label={props.block.presentation?.title ?? displayToolName(props.block.name, locale())}
        />
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

/** An alt text is a short description: the first line of the image description, clipped at a word. */
const altText = (description: string): string => {
  const line =
    description
      .split("\n")
      .find((entry) => entry.trim())
      ?.trim() ?? "";
  if (line.length <= 240) return line;
  const clipped = line.slice(0, 240);
  return `${clipped.slice(0, Math.max(clipped.lastIndexOf(" "), 160))}…`;
};

/**
 * The image a view_image step looked at, as a small fixed-size thumbnail: it loads lazily through the chat's own file
 * route, so it shows only what the viewer may read, and it keeps its box while it loads or fails. A host that opens
 * chat files shows it larger on click; the button is named for that action and described by the image's alt text.
 */
function StepImage(props: { path: string; src: string; description: string }) {
  const actions = useAiChatActions();
  const locale = useLocale();
  const imageId = createUniqueId();
  const [failed, setFailed] = createSignal(false);
  const name = () => props.path.slice(props.path.lastIndexOf("/") + 1) || props.path;
  const alt = () => altText(props.description);
  const image = () => (
    <Show when={!failed()} fallback={<i class="ti ti-photo-off text-lg text-dimmed" aria-hidden="true" />}>
      <img id={imageId} src={props.src} alt={alt() || name()} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </Show>
  );
  return (
    <Show when={actions.onOpenFile} fallback={<div class="ai-step-image">{image()}</div>}>
      {(open) => (
        <button
          type="button"
          class="ai-step-image focus-ui"
          aria-label={aiChatMessages(locale()).openImage({ name: name() })}
          aria-describedby={!failed() && alt() ? imageId : undefined}
          onClick={() => open()(props.path)}
        >
          {image()}
        </button>
      )}
    </Show>
  );
}

/**
 * One step in the expanded work list: its title, target, state, and outcome, with input and output on demand. An app
 * check names its outcome in words and with its own icon, so a passed and a failed check differ without colour.
 */
export function CompactToolRow(props: { block: ToolBlock; busy?: boolean }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const args = () => (isRecord(props.block.args) ? props.block.args : {});
  /**
   * A call that acts on something reads as its sentence, which already names what it acts on: what it will do while
   * it runs or waits, what it did once done, and what did not happen when it was rejected.
   */
  const sentence = () => {
    const status = props.block.status;
    const outcome =
      status === "completed" && !props.block.isError
        ? toolOutcome(props.block, "done", locale())
        : status === "rejected"
          ? toolOutcome(props.block, "rejected", locale())
          : null;
    return outcome ?? toolSubject(props.block, locale());
  };
  const detail = () =>
    sentence() ? undefined : [args().path, args().name, args().query, args().title].find((value) => typeof value === "string");
  const waiting = () => props.block.status === "awaiting_client" || props.block.status === "awaiting_approval";
  const state = () =>
    waiting() ? t().stepWaiting : props.block.status === "rejected" ? t().stepRejected : isFailedTool(props.block) ? t().stepFailed : "";
  const finished = () => props.block.status === "completed" && !props.block.isError;
  const check = () => (finished() ? codeCheckOutcome(props.block.name, props.block.result) : null);
  const outcome = () => {
    const value = check();
    if (!value) return "";
    const result = value.passed ? t().checkPassed : value.errors > 0 ? t().checkFindings({ count: value.errors }) : t().checkNotPassed;
    return value.warnings > 0 ? `${result} · ${t().checkWarnings({ count: value.warnings })}` : result;
  };
  const actions = useAiChatActions();
  /** Only a host that resolves chat file URLs shows the image; without one there is no preview, not an empty box. */
  const image = () => {
    const viewed = finished() ? viewedChatImage(props.block.name, props.block.result) : null;
    const src = viewed ? actions.fileUrl?.(viewed.path) : null;
    return viewed && src ? { ...viewed, src } : null;
  };
  const icon = () => {
    if (waiting()) return "ti ti-clock";
    const value = check();
    if (value) return value.passed ? "ti ti-circle-check" : "ti ti-alert-triangle";
    return aiToolIcon(props.block.name, props.block.presentation?.appIcon);
  };
  return (
    <AiToolActivity
      blockId={props.block.id}
      label={sentence() ?? props.block.presentation?.title ?? displayToolName(props.block.name, locale())}
      description={[
        props.block.status === "running" ? (props.block.progress ?? "") : "",
        typeof detail() === "string" ? String(detail()) : "",
        state(),
        outcome(),
      ]
        .filter(Boolean)
        .join(" · ")}
      icon={icon()}
      busy={props.busy && props.block.status === "running"}
      bodyInset={false}
      renderBody={() => (
        <div class="flex min-w-0 flex-col gap-2">
          <div
            class="max-h-72 overflow-auto overscroll-contain rounded-md bg-zinc-100 p-3 dark:bg-zinc-950"
            tabIndex={0}
            role="region"
            aria-label={t().toolInputOutput}
          >
            <ToolDetail title={t().input} toolName={props.block.name} value={props.block.args} />
            <ToolDetail title={t().output} toolName={props.block.name} value={props.block.result} />
          </div>
          {/* Below the input and output, so an image that arrives in an open step grows in like its output and moves nothing above. */}
          <Show when={image()}>{(viewed) => <StepImage path={viewed().path} src={viewed().src} description={viewed().description} />}</Show>
        </div>
      )}
    />
  );
}
