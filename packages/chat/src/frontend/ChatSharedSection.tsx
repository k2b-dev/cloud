import type { DateContext } from "@k2b/stdlib";
import { Button, DetailPanel, FilterToggle, InlineGuidance, Select, Skeleton, useLocale } from "@k2b/ui";
import { createEffect, createResource, createSignal, For, type JSX, Match, on, Show, Switch } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { SharedItem, SharedPageSchema, SharedQuerySchema } from "../service/contracts";
import type { ResourceCards } from "./ChatResourceCards";
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
  revision: number;
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
  let request = 0;
  const query = (next?: string) => ({
    kind: kind(),
    ...(thread() === "all" ? {} : { thread: thread() }),
    ...(next ? { cursor: next } : {}),
  });
  const load = async () => {
    const token = ++request;
    setStatus((current) => (current === "ready" && items().length > 0 ? current : "loading"));
    try {
      const page = await props.load(query());
      if (token !== request) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setStatus("ready");
    } catch {
      if (token === request) setStatus("failed");
    }
  };
  const more = async () => {
    const next = cursor();
    if (!next || loadingMore()) return;
    const token = request;
    setLoadingMore(true);
    try {
      const page = await props.load(query(next));
      if (token !== request) return;
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      if (token === request) setStatus("failed");
    } finally {
      setLoadingMore(false);
    }
  };
  createEffect(on([kind, thread, () => props.chatId, () => props.revision], () => void load()));

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
              <Button variant="text" size="xs" onClick={() => void load()}>
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
              <Button variant="text" size="xs" class="self-start" loading={loadingMore()} onClick={() => void more()}>
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
  const [view] = createResource(
    () => (props.item.kind === "element" ? props.cards : undefined),
    (cards) => (props.item.kind === "element" ? cards.view(props.item.ref) : Promise.resolve(undefined)),
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
