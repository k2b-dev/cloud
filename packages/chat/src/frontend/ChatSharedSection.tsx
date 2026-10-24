import type { DateContext } from "@k2b/stdlib";
import { Button, DetailPanel, FilterToggle, InlineGuidance, Select, Skeleton, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, Show, Switch } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { SharedItem, SharedPageSchema, SharedQuerySchema } from "../service/contracts";
import { type ResourceCards, useResourceCard } from "./ChatResourceCards";
import { listTime } from "./chat-format";
import { activeThreads, archivedThreads, type ThreadList } from "./threads";

type Kind = z.output<typeof SharedQuerySchema>["kind"];
type SharedPage = z.infer<typeof SharedPageSchema>;

const KINDS = [
  { kind: "all", icon: "ti ti-layout-list", label: "sharedAll" },
  { kind: "images", icon: "ti ti-photo", label: "sharedImages" },
  { kind: "documents", icon: "ti ti-file-text", label: "sharedDocuments" },
  { kind: "links", icon: "ti ti-link", label: "sharedLinks" },
  { kind: "elements", icon: "ti ti-box", label: "sharedElements" },
] as const satisfies readonly { kind: Kind; icon: string; label: string }[];

/**
 * What the chat shared, newest first: links and Cloud elements, filtered by kind and, in a chat with threads, by thread.
 * The list comes from the messages, so a deleted message or an element without access leaves it or shows as not
 * available. A row jumps to its message.
 */
export default function ChatSharedSection(props: {
  chatId: string;
  /** Changes when the history grows, so the list follows new messages while it is open. */
  /** The chat's newest position; absent until the chat is open. */
  revision: number | undefined;
  threads: ThreadList | null;
  viewerId: string;
  dateConfig: DateContext;
  now: () => Date;
  cards: ResourceCards | undefined;
  load: (query: z.input<typeof SharedQuerySchema>) => Promise<SharedPage>;
  onJump: (item: SharedItem) => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const [kind, setKind] = createSignal<Kind>("all");
  const [thread, setThread] = createSignal("all");
  const [items, setItems] = createSignal<readonly SharedItem[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "failed">("loading");
  const [loadingMore, setLoadingMore] = createSignal(false);
  // Loads run one after another, so a refresh and "Show more" never undo each other. A filter or chat starts a new
  // list: loads asked for the old one end without changing anything.
  let generation = 0;
  let chain: Promise<void> = Promise.resolve();
  let refreshQueued = false;
  const query = (next?: string) => ({
    kind: kind(),
    ...(thread() === "all" ? {} : { thread: thread() }),
    ...(next ? { cursor: next } : {}),
  });
  const run = (work: (list: number) => Promise<void>) => {
    const list = generation;
    chain = chain.then(() => (list === generation ? work(list) : undefined)).catch(() => {});
  };
  /**
   * Reads the list again as deep as the reader has loaded it, page by page through the server's own cursors, and
   * replaces rows and cursor together. New messages arrive at the top; deleted ones leave; nothing loaded is lost. New
   * messages while a refresh runs ask for one more refresh after it.
   */
  const refresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    run(async (list) => {
      refreshQueued = false;
      const depth = Math.max(items().length, 1);
      if (items().length === 0) setStatus("loading");
      try {
        let page = await props.load(query());
        const rows = [...page.items];
        while (rows.length < depth && page.nextCursor && list === generation) {
          page = await props.load(query(page.nextCursor));
          rows.push(...page.items);
        }
        if (list !== generation) return;
        setItems(rows);
        setCursor(page.nextCursor);
        setStatus("ready");
      } catch {
        if (list === generation) setStatus("failed");
      }
    });
  };
  const restart = () => {
    generation++;
    // A new list does not wait for loads of the old one; those finish without changing anything.
    chain = Promise.resolve();
    refreshQueued = false;
    setItems([]);
    setCursor(null);
    setLoadingMore(false);
    setStatus("loading");
    refresh();
  };
  const more = () => {
    if (!cursor() || loadingMore() || status() !== "ready") return;
    setLoadingMore(true);
    run(async (list) => {
      const next = cursor();
      try {
        if (!next) return;
        const page = await props.load(query(next));
        if (list !== generation) return;
        setItems((current) => [...current, ...page.items]);
        setCursor(page.nextCursor);
      } catch {
        if (list === generation) setStatus("failed");
      } finally {
        if (list === generation) setLoadingMore(false);
      }
    });
  };
  // The chat's record is replaced on every update; only another chat starts a new list, only a new position reads again.
  const chatId = createMemo(() => props.chatId);
  const revision = createMemo(() => props.revision);
  createEffect(on([kind, thread, chatId], restart));
  // A burst of new messages reads the list once.
  let pending: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(revision, (_next, previous) => {
      // The first run and the chat's first known position are the history the list already reads, not a new message.
      if (previous === undefined) return;
      clearTimeout(pending);
      pending = setTimeout(refresh, 300);
    }),
  );
  onCleanup(() => clearTimeout(pending));

  const threadOptions = () => [
    { value: "all", label: t().wholeChat, icon: "ti ti-messages" },
    { value: "general", label: t().general, icon: "ti ti-messages" },
    ...[...activeThreads(props.threads), ...archivedThreads(props.threads)].map((entry) => ({
      value: entry.id,
      label: entry.name,
      icon: entry.archived ? "ti ti-archive" : "ti ti-hash",
    })),
  ];
  const threadName = (id: string | null) =>
    id === null ? t().general : (props.threads?.items.find((entry) => entry.id === id)?.name ?? "");
  const meta = (item: SharedItem) => {
    const who = item.author.id === props.viewerId ? t().you : (item.author.name.trim().split(/\s+/u)[0] ?? "");
    const place = thread() === "all" && (props.threads?.items.length ?? 0) > 0 ? threadName(item.thread) : "";
    return [who, place, listTime(item.createdAt, props.now(), { ...props.dateConfig, locale: locale() })].filter(Boolean).join(" · ");
  };

  return (
    <DetailPanel.Section icon="ti ti-share" title={t().shared}>
      <div class="chat-shared">
        <div class="chat-shared__kinds" role="group" aria-label={t().sharedKinds}>
          <For each={KINDS}>
            {(entry) => (
              <FilterToggle icon={entry.icon} label={t()[entry.label]} active={kind() === entry.kind} onClick={() => setKind(entry.kind)} />
            )}
          </For>
        </div>
        <Show when={(props.threads?.items.length ?? 0) > 0}>
          <Select
            label={t().sharedThread}
            icon="ti ti-hash"
            value={thread}
            onValueChange={(value) => setThread(value ?? "all")}
            options={threadOptions()}
          />
        </Show>
        <Switch>
          <Match when={status() === "failed"}>
            <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
              {t().sharedFailed}{" "}
              <Button variant="text" size="xs" onClick={() => refresh()}>
                {t().retry}
              </Button>
            </InlineGuidance>
          </Match>
          <Match when={status() === "loading"}>
            <div class="chat-shared__loading" aria-hidden="true">
              <Skeleton />
              <Skeleton />
              <Skeleton />
            </div>
          </Match>
          <Match when={items().length === 0}>
            <p class="text-sm text-dimmed">{kind() === "all" && thread() === "all" ? t().nothingShared : t().nothingForFilter}</p>
          </Match>
          <Match when={true}>
            <ul class="chat-shared__list" aria-label={t().shared}>
              <For each={items()}>
                {(item) => <SharedRow item={item} meta={meta(item)} cards={props.cards} onJump={() => props.onJump(item)} />}
              </For>
            </ul>
            <Show when={cursor()}>
              <Button
                variant="text"
                size="xs"
                class="self-start"
                loading={loadingMore()}
                disabled={status() !== "ready"}
                onClick={() => more()}
              >
                {t().showMoreShared}
              </Button>
            </Show>
          </Match>
        </Switch>
      </div>
    </DetailPanel.Section>
  );
}

function SharedRow(props: { item: SharedItem; meta: string; cards: ResourceCards | undefined; onJump: () => void }): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const view = useResourceCard(
    () => props.cards,
    () => (props.item.kind === "element" ? props.item.ref : undefined),
  );
  const unavailable = () => props.item.kind === "element" && view() !== undefined && view()?.state !== "ok";
  const title = () => {
    if (props.item.kind === "link") return props.item.url.replace(/^https?:\/\//u, "");
    if (unavailable()) return t().elementUnavailable;
    return view()?.title ?? "";
  };
  const icon = () => (props.item.kind === "link" ? "ti ti-link" : unavailable() ? "ti ti-lock" : (view()?.icon ?? "ti ti-box"));
  return (
    <li>
      <button type="button" class="chat-shared__row" data-unavailable={unavailable() ? "" : undefined} onClick={() => props.onJump()}>
        <span class="chat-shared__icon" aria-hidden="true">
          <i class={icon()} />
        </span>
        <span class="chat-shared__copy">
          <span class="chat-shared__title">{title() || " "}</span>
          <span class="chat-shared__meta">{unavailable() ? `${t().noAccess} · ${props.meta}` : props.meta}</span>
        </span>
      </button>
    </li>
  );
}
