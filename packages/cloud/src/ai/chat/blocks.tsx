import { dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, Chat, isStructuredDataValue, SplitButton, StructuredDataPreview } from "@k2b/ui";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import type { CapabilityActionReview } from "../../contracts/capabilities";
import { markdown } from "../../shared";
import type { AiTurnBlock } from "../protocol";
import { isRenderableTurnBlock } from "../protocol";
import { hasSpecializedBuiltinToolView, SpecializedBuiltinToolBlock } from "./builtin-tools";
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
import { AssistantMarkdownBlock } from "./primitives";
import { AiToolActivity, AiToolDisclosureProvider, type AiToolDisclosureState, createAiToolDisclosureState } from "./tool-disclosure";
import { CloudCardBlock, CloudSurveyBlock, CloudSurveyResultBlock, CloudTextEditorBlock, CloudTextEditorResultBlock } from "./visual-tools";
import { FetchFileToolBlock, WebExtractToolBlock, WebSearchToolBlock } from "./web-tools";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
type ReviewDetail = NonNullable<CapabilityActionReview["details"]>[number];

const reviewDetailText = (detail: ReviewDetail): string => {
  if (detail.format === "date")
    return /^\d{4}-\d{2}-\d{2}$/.test(detail.value)
      ? dates.formatDate(`${detail.value}T12:00:00.000Z`, { timeZone: "UTC" })
      : dates.formatDate(detail.value);
  if (detail.format === "date-time") return dates.formatDateTime(detail.value);
  return detail.value;
};

function ReviewDetailValue(props: { detail: ReviewDetail }) {
  const value = () => reviewDetailText(props.detail);
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
  return (
    <Show
      when={props.text.trim()}
      fallback={
        <Show when={props.streaming}>
          <Chat.Activity label="Thinking" icon="ti ti-sparkles" tone="ai" busy />
        </Show>
      }
    >
      <Chat.Activity label="Show reasoning" icon="ti ti-sparkles" tone="ai" bodyInset={false}>
        <pre class="max-h-52 w-full min-w-0 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-100/70 p-2 text-[11px] leading-5 text-secondary [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
          {props.text}
        </pre>
      </Chat.Activity>
    </Show>
  );
}

function CompactionBlockView(props: { block: Extract<AiTurnBlock, { kind: "compaction" }> }) {
  const status = () => props.block.status;
  const description = () => {
    if (status() === "completed") return "Context compacted";
    if (status() === "skipped") return "No-op";
    if (status() === "failed") return "Compaction failed";
    return "Compacting context";
  };

  return (
    <Show when={status() !== "running"} fallback={<Chat.Activity label="Compacting context" icon="ti ti-brain" tone="ai" busy />}>
      <Chat.Activity
        label="Show compaction"
        description={description()}
        icon="ti ti-brain"
        tone={status() === "failed" ? "danger" : "ai"}
        bodyInset={false}
      >
        <div class="w-full min-w-0 rounded-md bg-zinc-100/70 p-2 text-[11px] leading-5 text-secondary [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
          <Show when={props.block.result} fallback={<p>Older chat context was summarized into compact conversation memory.</p>}>
            {(compactResult) => (
              <dl class="grid grid-cols-2 gap-2">
                <div class="rounded-md bg-white/65 px-2 py-1 dark:bg-white/5">
                  <dt class="uppercase tracking-wide text-dimmed">Before</dt>
                  <dd class="font-medium text-primary">{compactResult().entriesBefore.toLocaleString()}</dd>
                </div>
                <div class="rounded-md bg-white/65 px-2 py-1 dark:bg-white/5">
                  <dt class="uppercase tracking-wide text-dimmed">After</dt>
                  <dd class="font-medium text-primary">{compactResult().entriesAfter.toLocaleString()}</dd>
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
  return (
    <AiToolActivity
      blockId={props.blockId}
      icon={props.icon ?? (props.isError ? "ti ti-alert-circle" : aiToolIcon(props.toolName))}
      label={props.isError ? (props.errorLabel ?? `${props.labelOnError ?? props.name} failed`) : props.name}
      description={props.isError ? props.errorDescription : undefined}
      tone={props.isError ? "danger" : "neutral"}
      accent={props.accent}
      defaultOpen={props.isError}
      bodyInset={false}
    >
      <div class="flex w-full min-w-0 flex-col gap-2">
        <Show when={props.args !== undefined}>
          <ToolDetail title="Input" toolName={props.toolName} value={props.args} />
        </Show>
        <ToolDetail title="Response" toolName={props.toolName} value={props.result} />
      </div>
    </AiToolActivity>
  );
}

function ApprovalBlockView(props: { turnId: string; block: ToolBlock }) {
  const actions = useAiChatActions();
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
  const ownerName = () => props.block.presentation?.appName ?? "Assistant";
  const description = () => {
    const reviewMessage = props.block.approval?.review?.message.trim();
    if (reviewMessage) return reviewMessage;
    const message = props.block.approval?.message?.trim();
    if (!message) return null;
    const duplicateTitle = props.block.presentation ? `${props.block.presentation.appName}: ${props.block.presentation.title}\n` : "";
    const withoutDuplicateTitle = message.startsWith(duplicateTitle) ? message.slice(duplicateTitle.length).trim() : message;
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
      open: `Open in ${ownerName()}`,
      edit: `Edit in ${ownerName()}`,
      status: `View status in ${ownerName()}`,
      preview: "Preview",
      download: "Download",
    })[rel];
  const detailData = () => (isStructuredDataValue(props.block.args) ? props.block.args : undefined);
  const appAccent = () => props.block.presentation?.appAccent;
  const detailsId = `approval-details-${props.block.callId}`;
  return (
    <div class="w-full">
      <section
        class={`w-full overflow-hidden rounded-xl border border-[var(--k2b-border)] bg-[var(--k2b-surface)] text-sm text-primary ${appAccent() ? "app-accent-scope" : ""}`}
        style={{ "--app-accent": appAccent() }}
        aria-label={`Approval required: ${title()}`}
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
              <p class="text-xs text-dimmed">Action</p>
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
                    <pre
                      class="max-h-72 overflow-auto whitespace-pre-wrap break-words pr-2 font-sans text-xs leading-5 text-secondary"
                      role="region"
                      tabIndex={0}
                      aria-label={`${detail.label} content`}
                    >
                      <ReviewDetailValue detail={detail} />
                    </pre>
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
            <nav class="flex flex-wrap gap-1" aria-label={`${title()} links`}>
              <For each={reviewLinks()}>
                {(link) => (
                  <ButtonLink href={link.href} size="xs" variant="ghost">
                    {link.title ?? reviewLinkTitle(link.rel)}
                  </ButtonLink>
                )}
              </For>
            </nav>
          </Show>
          <Show when={approval.error()}>
            <p class="text-xs text-red-700 dark:text-red-300">Could not submit. Try again.</p>
          </Show>
          <div class="ml-auto shrink-0">
            <Show
              when={pending()}
              fallback={
                <span class="text-xs font-medium text-secondary">
                  {title()} · {props.block.status === "rejected" ? "Rejected" : "Approved"}
                </span>
              }
            >
              <Show when={actions.onApproval} fallback={<span class="text-xs font-medium text-secondary">Approval unavailable</span>}>
                <Show
                  when={!actionDisabled()}
                  fallback={
                    <span class="inline-flex items-center gap-1 text-xs font-medium text-secondary">
                      <i class="ti ti-player-stop" aria-hidden="true" />
                      Stopping response
                    </span>
                  }
                >
                  <Show
                    when={!approval.loading() && !submitted()}
                    fallback={
                      <span class="inline-flex items-center gap-1 text-xs font-medium text-secondary">
                        <i class={`ti ${submitted() ? "ti-check" : "ti-loader-2 animate-spin"}`} aria-hidden="true" />
                        {submitted() ? "Submitted" : "Submitting"}
                      </span>
                    }
                  >
                    <div class="flex flex-wrap justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => submit({ approved: false })}>
                        Reject
                      </Button>
                      <SplitButton
                        size="xs"
                        variant="ai"
                        onClick={() => submit({ approved: true })}
                        menuLabel={`More options for ${title()}`}
                        menuPosition="bottom-right"
                        items={[
                          {
                            label: detailsOpen() ? "Hide details" : "Details",
                            icon: detailsOpen() ? "ti ti-eye-off" : "ti ti-eye",
                            action: () => setDetailsOpen((open) => !open),
                          },
                          ...(props.block.approval?.allowAlways
                            ? [
                                {
                                  label: "Always approve",
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
        <div id={detailsId} class="mt-2 w-full" role="region" aria-label={`${title()} details`}>
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
            label={`${label()} failed`}
            description={capabilityErrorDescription(props.block.result)}
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
                      <ButtonLink class="ai-chat-result-link" href={String(link.href)} size="xs" variant="ghost">
                        {typeof link.title === "string"
                          ? link.title
                          : link.rel === "edit"
                            ? "Edit"
                            : link.rel === "download"
                              ? "Download"
                              : "Open"}
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
  );
}

function RejectedToolView(props: { block: ToolBlock }) {
  const presentation = () => props.block.presentation;
  const title = () => presentation()?.title ?? displayToolName(props.block.name);
  return (
    <Chat.Activity
      icon={aiToolIcon(props.block.name, presentation()?.appIcon)}
      label={`${title()} was rejected`}
      accent={presentation()?.appAccent}
    />
  );
}

function SurveyToolView(props: { turnId: string; block: ToolBlock; active?: boolean }) {
  const actions = useAiChatActions();
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
          disabledLabel={actions.actionDisabled?.() ? "Stopping response." : undefined}
          onSubmit={submit ? (result) => submit(request(), result) : undefined}
        />
      </Match>
      <Match when={submittedResult()}>
        {(result) => (
          <CloudSurveyResultBlock blockId={props.block.id} args={props.block.args} result={result()} continuing={props.active} />
        )}
      </Match>
    </Switch>
  );
}

function TextEditorToolView(props: { turnId: string; block: ToolBlock; active?: boolean }) {
  const actions = useAiChatActions();
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
          name="text editor"
          toolName={props.block.name}
          args={props.block.args}
          result={props.block.result}
          isError={Boolean(props.block.isError)}
        />
      }
    >
      <Match when={props.block.status === "running"}>
        <Chat.Activity label="Preparing text editor" icon="ti ti-edit" tone="ai" busy />
      </Match>
      <Match when={props.block.status === "awaiting_client"}>
        <CloudTextEditorBlock
          args={props.block.args}
          disabled={!submit || actions.actionDisabled?.()}
          disabledLabel={actions.actionDisabled?.() ? "Stopping response." : undefined}
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
  const presentation = () => memoryToolPresentation(props.block.args, props.block.result);
  return (
    <Show when={props.block.status !== "running"} fallback={<Chat.Activity label="Using memory" icon="ti ti-brain" tone="ai" busy />}>
      <Show
        when={presentation()}
        fallback={
          <ToolResultDisclosure
            blockId={props.block.id}
            name="Memory"
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
  const status = () => props.block.status;
  const fetchError = () =>
    props.block.name === "fetch_file" && props.block.isError ? fetchFileErrorPresentation(props.block.result) : undefined;
  return (
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
      <Match when={hasSpecializedBuiltinToolView(props.block.name, props.block.result) && status() === "completed" && !props.block.isError}>
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
  );
}

/** Render one unified turn block. Shared by persisted assistant groups and the live turn. */
export function AiTurnBlockView(props: { block: AiTurnBlock; turnId: string; streaming?: boolean; active?: boolean }) {
  // block.kind is immutable for a given block id, so this switch may run once.
  const block = props.block;
  switch (block.kind) {
    case "text":
      return <AssistantMarkdownBlock html={markdown.renderSync(block.text)} />;
    case "thinking":
      return <ThinkingBlockView text={block.text} streaming={props.streaming} />;
    case "steer_message":
      return null;
    case "steer_applied":
      return <Chat.Activity label="Conversation steered" icon="ti ti-route" tone="ai" />;
    case "tool":
      return <ToolBlockView turnId={props.turnId} block={block} active={props.active} />;
    case "compaction":
      return <CompactionBlockView block={block} />;
  }
}

export function AiTurnBlockList(props: {
  blocks: AiTurnBlock[];
  turnId: string;
  streaming?: boolean;
  compact?: boolean;
  active?: boolean;
  disclosureState?: AiToolDisclosureState;
}) {
  const visible = () => props.blocks.filter(isRenderableTurnBlock);
  const disclosureState = props.disclosureState ?? createAiToolDisclosureState();
  return (
    <Show when={visible().length > 0}>
      <AiToolDisclosureProvider state={disclosureState}>
        <div class={`flex flex-col ${props.compact ? "gap-1" : "gap-2"}`}>
          <For each={visible()}>
            {(block, index) => (
              <AiTurnBlockView
                block={block}
                turnId={props.turnId}
                streaming={props.streaming && index() === visible().length - 1}
                active={props.active}
              />
            )}
          </For>
        </div>
      </AiToolDisclosureProvider>
    </Show>
  );
}
