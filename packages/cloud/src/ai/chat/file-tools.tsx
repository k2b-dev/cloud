import { fileIcons } from "@k2b/stdlib";
import { Chat } from "@k2b/ui";
import { Show } from "solid-js";
import { formatAiFileSize } from "../attachments";
import type { AiTurnBlock } from "../protocol";
import { useAiChatActions } from "./message-actions";
import { aiToolIcon, isRecord } from "./message-utils";

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

export function PresentToolBlock(props: { block: ToolBlock }) {
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
      <div class="inline-flex min-h-7 max-w-full items-center gap-1.5 py-1 text-xs leading-none text-dimmed">
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
        <Show when={title()}>
          <span class="min-w-0 truncate">{name()}</span>
        </Show>
        <Show when={file()!.size > 0}>
          <span class="shrink-0">{formatAiFileSize(file()!.size)}</span>
        </Show>
        <Show when={href()}>
          {(downloadHref) => (
            <a
              class="inline-flex shrink-0 items-center gap-1 font-medium text-secondary underline-offset-2 transition-colors hover:text-primary hover:underline"
              href={downloadHref()}
              download={name()}
              title={`Download ${name()}`}
            >
              <i class="ti ti-download text-sm leading-none" aria-hidden="true" />
              Download
            </a>
          )}
        </Show>
      </div>
    </Show>
  );
}
