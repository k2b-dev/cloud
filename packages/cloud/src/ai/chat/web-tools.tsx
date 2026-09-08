import { Chat, ScrollArea } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { formatAiFileSize } from "../attachments";
import type { AiTurnBlock } from "../protocol";
import { isRecord } from "./message-utils";
import { AiToolActivity } from "./tool-disclosure";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// First-party favicon only: fetching from the result's own origin leaks nothing
// beyond what the search already surfaced — unlike Google/DDG favicon services.
const faviconUrl = (url: string): string | null => {
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return null;
  }
};

function Favicon(props: { url: string; fallbackIcon?: string }) {
  const [failed, setFailed] = createSignal(false);
  const src = () => (failed() ? null : faviconUrl(props.url));
  return (
    <span class="grid h-4 w-4 shrink-0 place-items-center" aria-hidden="true">
      <Show when={src()} fallback={<i class={`${props.fallbackIcon ?? "ti ti-world"} text-sm text-dimmed`} />}>
        <img src={src() ?? undefined} alt="" class="h-4 w-4 rounded-sm" loading="lazy" onError={() => setFailed(true)} />
      </Show>
    </span>
  );
}

function WebLinkRow(props: { url: string; title: string }) {
  return (
    <a
      href={props.url}
      target="_blank"
      rel="noreferrer noopener"
      class="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-white/65 dark:hover:bg-white/10"
    >
      <Favicon url={props.url} />
      <span class="min-w-0 flex-1 truncate text-primary">{props.title || props.url}</span>
      <span class="shrink-0 text-[11px] text-dimmed">{domainOf(props.url)}</span>
      <i class="ti ti-external-link shrink-0 text-[11px] text-dimmed" aria-hidden="true" />
    </a>
  );
}

const searchQuery = (args: unknown): string => (isRecord(args) && typeof args.query === "string" ? args.query : "Web search");

const searchResults = (result: unknown): { title: string; url: string }[] => {
  if (!Array.isArray(result)) return [];
  return result
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && typeof entry.url === "string")
    .map((entry) => ({ url: String(entry.url), title: typeof entry.title === "string" ? entry.title : "" }));
};

/** Claude-style source list for a finished web search: favicon, title, domain per result. */
export function WebSearchToolBlock(props: { block: ToolBlock }) {
  const running = () => props.block.status !== "completed";
  const results = () => searchResults(props.block.result);

  return (
    <Show when={!running()} fallback={<Chat.Activity label={searchQuery(props.block.args)} icon="ti ti-search" busy />}>
      <AiToolActivity
        blockId={props.block.id}
        defaultOpen
        icon="ti ti-search"
        label={searchQuery(props.block.args)}
        description={`${results().length} result${results().length === 1 ? "" : "s"}`}
        bodyInset={false}
      >
        <ScrollArea class="max-h-56 w-full min-w-0 rounded-md bg-zinc-100/70 p-1 text-xs [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
          <Show when={results().length > 0} fallback={<p class="px-2 py-1.5 text-dimmed">No results.</p>}>
            <For each={results()}>{(result) => <WebLinkRow url={result.url} title={result.title} />}</For>
          </Show>
        </ScrollArea>
      </AiToolActivity>
    </Show>
  );
}

const extractUrl = (block: ToolBlock): string => {
  if (isRecord(block.result) && typeof block.result.url === "string") return block.result.url;
  if (isRecord(block.args) && typeof block.args.url === "string") return block.args.url;
  return "";
};

/** One visited page: favicon + title row, description and truncation hint behind the disclosure. */
export function WebExtractToolBlock(props: { block: ToolBlock }) {
  const running = () => props.block.status !== "completed";
  const url = () => extractUrl(props.block);
  const title = () => (isRecord(props.block.result) && typeof props.block.result.title === "string" ? props.block.result.title : "");
  const description = () =>
    isRecord(props.block.result) && typeof props.block.result.description === "string" ? props.block.result.description : "";
  const truncated = () => isRecord(props.block.result) && props.block.result.truncated === true;

  return (
    <Show when={!running()} fallback={<Chat.Activity label={domainOf(url()) || "Reading page"} icon="ti ti-world-download" busy />}>
      <AiToolActivity
        blockId={props.block.id}
        defaultOpen
        icon="ti ti-world-download"
        leading={<Favicon url={url()} fallbackIcon="ti ti-world-download" />}
        label={title() || domainOf(url())}
        bodyInset={false}
      >
        <div class="flex w-full min-w-0 flex-col gap-0.5 rounded-md bg-zinc-100/70 px-2 py-1.5 text-xs [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
          <a
            href={url()}
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex w-fit items-center gap-1 text-secondary transition-colors hover:text-primary"
          >
            <span class="truncate">{domainOf(url())}</span>
            <i class="ti ti-external-link shrink-0 text-[11px] text-dimmed" aria-hidden="true" />
          </a>
          <Show when={description()}>
            <p class="text-dimmed">{description()}</p>
          </Show>
          <Show when={truncated()}>
            <p class="text-[11px] text-dimmed">Content was truncated for the model.</p>
          </Show>
        </div>
      </AiToolActivity>
    </Show>
  );
}

type FetchFileResult = { path: string; size: number; mediaType: string; url: string };

const fetchFileResult = (value: unknown): FetchFileResult | null =>
  isRecord(value) &&
  typeof value.path === "string" &&
  typeof value.size === "number" &&
  typeof value.mediaType === "string" &&
  typeof value.url === "string"
    ? { path: value.path, size: value.size, mediaType: value.mediaType, url: value.url }
    : null;

const filenameOf = (value: string): string => {
  try {
    const name = new URL(value).pathname.split("/").filter(Boolean).at(-1);
    return name ? decodeURIComponent(name) : domainOf(value);
  } catch {
    return value.split("/").filter(Boolean).at(-1) ?? "file";
  }
};

/** Imported web file: source identity, useful metadata, and chat path without raw tool JSON. */
export function FetchFileToolBlock(props: { block: ToolBlock }) {
  const sourceUrl = () => (isRecord(props.block.args) && typeof props.block.args.url === "string" ? props.block.args.url : "");
  const result = () => fetchFileResult(props.block.result);
  const displayName = () => filenameOf(result()?.path ?? sourceUrl()) || "file";
  const description = () => {
    const file = result();
    if (!file) return domainOf(sourceUrl());
    return [domainOf(sourceUrl() || file.url), formatAiFileSize(file.size), file.mediaType].filter(Boolean).join(" · ");
  };

  return (
    <Show
      when={props.block.status === "completed" && result()}
      fallback={
        <Chat.Activity
          label={`Fetching ${displayName()}`}
          description={domainOf(sourceUrl())}
          leading={<Favicon url={sourceUrl()} fallbackIcon="ti ti-world-download" />}
          busy
        />
      }
    >
      {(file) => (
        <AiToolActivity
          blockId={props.block.id}
          leading={<Favicon url={sourceUrl() || file().url} fallbackIcon="ti ti-world-download" />}
          label={`Fetched ${displayName()}`}
          description={description()}
          bodyInset={false}
        >
          <dl class="grid w-full min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-zinc-100/70 px-2 py-1.5 text-xs [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
            <dt class="font-medium text-dimmed">Source</dt>
            <dd class="min-w-0 truncate">
              <a href={file().url} target="_blank" rel="noreferrer noopener" class="text-secondary hover:text-primary">
                {file().url}
              </a>
            </dd>
            <dt class="font-medium text-dimmed">Saved as</dt>
            <dd class="min-w-0 truncate text-secondary">{file().path}</dd>
          </dl>
        </AiToolActivity>
      )}
    </Show>
  );
}
