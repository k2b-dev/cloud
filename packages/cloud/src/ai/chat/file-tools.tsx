import { fileIcons } from "@k2b/stdlib";
import { Chat } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import { formatAiFileSize } from "../attachments";
import type { AiTurnBlock } from "../protocol";
import { CloudAiViewSummarySchema, isAiViewFile } from "../view-block";
import { useAiChatActions } from "./message-actions";
import { aiToolIcon, isRecord } from "./message-utils";
import { CloudViewBlock } from "./view-block";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
type PresentResult = { path: string; size: number; mediaType: string };

const presentResult = (block: ToolBlock): PresentResult | null => {
  if (block.status === "running") return null;
  if (isRecord(block.result) && typeof block.result.path === "string") {
    return { path: block.result.path, size: Number(block.result.size ?? 0), mediaType: String(block.result.mediaType ?? "") };
  }
  if (isRecord(block.args) && typeof block.args.path === "string") {
    return { path: block.args.path, size: 0, mediaType: "" };
  }
  return null;
};

/** The summary `present` returns for a view file; Cloud gives it only for assistant files below /views. */
const presentedView = (block: ToolBlock) => {
  if (block.status !== "completed" || block.isError || !isRecord(block.result) || typeof block.result.path !== "string") return null;
  const summary = CloudAiViewSummarySchema.safeParse(block.result.view);
  return summary.success && isAiViewFile({ path: block.result.path, origin: "assistant" })
    ? { path: block.result.path, summary: summary.data }
    : null;
};

/**
 * A view's size comes with the finished call's summary. Until then the work line names the step and the result slot
 * stays empty, so no one-line placeholder grows into the chart or table.
 */
const preparingView = (block: ToolBlock) =>
  block.status === "running" && isRecord(block.args) && typeof block.args.path === "string"
    ? isAiViewFile({ path: block.args.path.trim(), origin: "assistant" })
    : false;

/** A presented file: a view file shows as its chart or table, every other file as a chip to open and download. */
export function PresentToolBlock(props: { block: ToolBlock }) {
  // Live updates replace the block with an equal result; only a different view loads again.
  const view = createMemo(() => presentedView(props.block), null, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  return (
    <Show
      when={view()}
      keyed
      fallback={
        <Show when={!preparingView(props.block)}>
          <PresentedFile block={props.block} />
        </Show>
      }
    >
      {(view) => <CloudViewBlock path={view.path} summary={view.summary} />}
    </Show>
  );
}

function PresentedFile(props: { block: ToolBlock }) {
  const actions = useAiChatActions();
  const file = () => presentResult(props.block);
  const title = () => (isRecord(props.block.args) && typeof props.block.args.title === "string" ? props.block.args.title : null);
  const name = () => {
    const path = file()?.path ?? "";
    return path.slice(path.lastIndexOf("/") + 1) || path;
  };
  const icon = () => fileIcons.getFileIcon({ name: name(), type: "file", mimeType: file()?.mediaType || "application/octet-stream" });
  const href = () => (file() ? (actions.fileUrl?.(file()!.path) ?? null) : null);

  return (
    <Show
      when={file() && !props.block.isError}
      fallback={
        <Show when={props.block.status === "running"}>
          <Chat.Activity label="Preparing file" icon={aiToolIcon(props.block.name)} busy />
        </Show>
      }
    >
      <div
        data-call-id={props.block.callId}
        class="inline-flex min-h-7 max-w-full items-center gap-1.5 py-1 text-xs leading-none text-dimmed"
      >
        <i class={`ti ${icon()} shrink-0 text-base leading-none`} aria-hidden="true" />
        <Show
          when={actions.onOpenFile}
          fallback={
            <span class="min-w-0 truncate font-medium text-secondary" title={file()!.path}>
              {title() ?? name()}
            </span>
          }
        >
          <button
            type="button"
            class="min-w-0 truncate font-medium text-secondary underline-offset-2 hover:text-primary hover:underline focus-ui"
            title={`Open ${file()!.path}`}
            onClick={() => actions.onOpenFile?.(file()!.path)}
          >
            {title() ?? name()}
          </button>
        </Show>
        <Show when={file()!.size > 0}>
          <span class="shrink-0">{formatAiFileSize(file()!.size)}</span>
        </Show>
        <Show when={href()}>
          {(downloadHref) => (
            <a
              class="group inline-flex shrink-0 items-center gap-1 font-medium text-secondary transition-colors hover:text-primary"
              href={downloadHref()}
              download={name()}
              title={`Download ${name()}`}
            >
              <i class="ti ti-download text-sm leading-none" aria-hidden="true" />
              <span class="underline-offset-2 group-hover:underline">Download</span>
            </a>
          )}
        </Show>
      </div>
    </Show>
  );
}
