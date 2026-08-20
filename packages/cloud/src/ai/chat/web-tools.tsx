import { Chat } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { AiTurnBlock } from "../protocol";
import { isRecord } from "./message-utils";

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
      <Chat.Activity
        defaultOpen
        icon="ti ti-search"
        label={searchQuery(props.block.args)}
        description={`${results().length} result${results().length === 1 ? "" : "s"}`}
        bodyInset={false}
      >
        <div class="max-h-56 w-full min-w-0 overflow-y-auto rounded-md bg-zinc-100/70 p-1 text-xs [box-shadow:var(--ui-control-recess)] dark:bg-zinc-950/70">
          <Show when={results().length > 0} fallback={<p class="px-2 py-1.5 text-dimmed">No results.</p>}>
            <For each={results()}>{(result) => <WebLinkRow url={result.url} title={result.title} />}</For>
          </Show>
        </div>
      </Chat.Activity>
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
      <Chat.Activity
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
      </Chat.Activity>
    </Show>
  );
}
