import { Chat, useLocale } from "@k2b/ui";
import { createContext, type JSX, Show, useContext } from "solid-js";
import type { AiTurnBlock } from "../protocol";
import { toolOutcome, toolSubject, useReaderTimeZone } from "./action-sentences";
import { AiAppTile } from "./answer-sources";
import { aiToolIcon, displayToolName, isRecord } from "./message-utils";
import { aiChatMessages } from "./messages";
import { AiToolActivity } from "./tool-disclosure";
import { isFailedTool } from "./tool-groups";
import { WebsiteReceipts, websiteReceipts } from "./web-tools";
import { stepFailure } from "./work-summary";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/**
 * Calls whose opened step still shows its own detail view: code tools, whose steps feat/code words as a progress of
 * their own, and image inspections, whose step shows the image. Every other call is a step in words.
 */
export const keepsStepDetail = (name: string): boolean => name.startsWith("code_") || name === "view_image";

const resultSummary = (block: ToolBlock): string => {
  const value = isRecord(block.result) ? block.result.summary : undefined;
  return typeof value === "string" && value.trim().length <= 500 ? value.trim() : "";
};

/** Why a call did not go through, in the reader's words; the app's codes and messages stay in the data. */
const failureReason = (block: ToolBlock, t: ReturnType<typeof aiChatMessages>): string => {
  const kind = stepFailure(block);
  return kind === "denied"
    ? t.stepNoAccess
    : kind === "not_found"
      ? t.stepNotFound
      : kind === "timeout"
        ? t.stepTimedOut
        : t.stepDidNotWork;
};

/**
 * Whether the turn went on after a step: some later block exists. Given by the opened work list, so a failed step says
 * "Went on without this result" only when something really followed it.
 */
export const AiWorkFollowedContext = createContext<(id: string) => boolean>(() => false);

/** What a call acts on when it has no sentence of its own: the path, name, query, or title it was given. */
const target = (block: ToolBlock): string => {
  const args = isRecord(block.args) ? block.args : {};
  const value = [args.path, args.name, args.query, args.title].find((entry) => typeof entry === "string" && entry.trim());
  return typeof value === "string" ? value.trim() : "";
};

/** A step's app tile: the app's icon in its colour, or a neutral tile with the tool's icon. */
export function AiStepTile(props: { block: ToolBlock }): JSX.Element {
  return <AiAppTile icon={aiToolIcon(props.block.name, props.block.presentation?.appIcon)} accent={props.block.presentation?.appAccent} />;
}

/**
 * One step of the opened work, in words: the app tile, what the step did, and below it what came of it. A step that did
 * not go through says why and, when the turn went on after it, that it went on without the result.
 */
export function AiWorkStep(props: { block: ToolBlock; busy: boolean }): JSX.Element {
  const locale = useLocale();
  const followed = useContext(AiWorkFollowedContext);
  const timeZone = useReaderTimeZone();
  const t = () => aiChatMessages(locale());
  const failed = () => props.block.status !== "rejected" && isFailedTool(props.block);
  const sentence = () => {
    const status = props.block.status;
    const outcome =
      status === "completed" && !props.block.isError
        ? toolOutcome(props.block, "done", locale(), timeZone)
        : status === "rejected"
          ? toolOutcome(props.block, "rejected", locale(), timeZone)
          : null;
    return outcome ?? toolSubject(props.block, locale(), timeZone);
  };
  const label = () => sentence() ?? props.block.presentation?.title ?? displayToolName(props.block.name, locale());
  const detail = () => {
    if (failed()) return [failureReason(props.block, t()), followed(props.block.id) ? t().stepWentOn : ""].join(" ").trim();
    const waiting = props.block.status === "awaiting_client" || props.block.status === "awaiting_approval";
    return [
      sentence() ? "" : target(props.block),
      props.block.status === "running" ? (props.block.progress ?? "") : "",
      props.block.status === "completed" ? resultSummary(props.block) : "",
      waiting ? t().stepWaiting : props.block.status === "rejected" ? t().stepRejected : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <>
      <Chat.Activity
        class={`ai-work-step${failed() ? " ai-work-step--failed" : ""}`}
        wrap
        leading={<AiStepTile block={props.block} />}
        label={label()}
        description={detail() || undefined}
        busy={props.busy && props.block.status === "running"}
      />
      <Show when={websiteReceipts(props.block).length > 0}>
        <WebsiteReceipts block={props.block} />
      </Show>
    </>
  );
}

/** Thinking is a step: "Thought it over", with Gustav's tile. Its reasoning opens in place. */
export function AiThoughtStep(props: { block: Extract<AiTurnBlock, { kind: "thinking" }>; busy: boolean }): JSX.Element {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const tile = () => <AiAppTile icon="ti ti-sparkles" accent="var(--k2b-ai-accent)" />;
  return (
    <Show
      when={props.block.text.trim()}
      fallback={<Chat.Activity class="ai-work-step" leading={tile()} label={t().stepThinking} busy={props.busy} />}
    >
      <AiToolActivity
        blockId={props.block.id}
        class="ai-work-step"
        leading={tile()}
        label={props.busy ? t().stepThinking : t().stepThought}
        busy={props.busy}
        bodyInset={false}
        renderBody={() => <p class="ai-turn-steps__thought">{props.block.text.trim()}</p>}
      />
    </Show>
  );
}
