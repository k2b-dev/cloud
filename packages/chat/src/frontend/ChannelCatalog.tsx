import { AnchoredPopover, AppWorkspace, Button, InlineGuidance, Skeleton, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import type { z } from "zod";
import { chatMessages } from "../messages";
import type { ConversationPageSchema } from "../service/contracts";
import { ChatAvatar, channelLine } from "./ChatList";
import { createChannelApi } from "./channel-api";

type Page = z.infer<typeof ConversationPageSchema>;

/**
 * "Discover channels" beside the Channels section: the discoverable catalog in a popover, loaded when it opens.
 * Choosing a channel opens it in the chat area, where a reader who has not subscribed is asked to subscribe.
 */
export default function ChannelCatalog(props: {
  /** The button the catalog opens beside; the catalog is open while it is set. */
  anchor: HTMLElement | undefined;
  onClose: () => void;
  onOpen: (id: string) => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  const api = createChannelApi();
  const [query, setQuery] = createSignal("");
  const [rows, setRows] = createSignal<Page["items"]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(true);
  const [failed, setFailed] = createSignal(false);
  let search: HTMLInputElement | undefined;
  let request: AbortController | undefined;
  const load = async (more = false) => {
    request?.abort();
    const current = new AbortController();
    request = current;
    setBusy(true);
    setFailed(false);
    try {
      const page = await api.browse(query().trim(), more ? (cursor() ?? undefined) : undefined, current.signal);
      if (current.signal.aborted) return;
      setRows(more ? [...rows(), ...page.items] : page.items);
      setCursor(page.nextCursor);
    } catch {
      if (!current.signal.aborted) setFailed(true);
    } finally {
      if (request === current) setBusy(false);
    }
  };
  // Each opening reads the current catalog; typing reads again after a pause.
  createEffect(
    on(
      () => props.anchor,
      (anchor) => {
        if (anchor) void load();
      },
    ),
  );
  createEffect(
    on(
      query,
      () => {
        if (!props.anchor) return;
        const timer = setTimeout(() => void load(), 250);
        onCleanup(() => clearTimeout(timer));
      },
      { defer: true },
    ),
  );
  onCleanup(() => request?.abort());
  return (
    <AnchoredPopover
      anchor={props.anchor}
      onClose={props.onClose}
      label={t().browseChannels}
      align="end"
      width="20rem"
      plannedHeight={420}
      initialFocus={() => search}
      class="chat-channel-catalog"
    >
      <div class="chat-channel-catalog__body">
        <TextInput
          ref={(element: HTMLInputElement) => (search = element)}
          type="search"
          icon="ti ti-search"
          aria-label={t().searchChannels}
          placeholder={t().searchChannels}
          maxLength={100}
          value={query}
          onValueChange={setQuery}
        />
        <div class="chat-channel-catalog__rows" aria-busy={busy()}>
          <Show when={busy() && rows().length === 0 && !failed()}>
            <For each={[0, 1, 2]}>{() => <Skeleton class="chat-channel-catalog__skeleton" />}</For>
          </Show>
          <Show when={failed()}>
            <InlineGuidance tone="danger" role="alert">
              {t().channelListFailed}{" "}
              <Button variant="text" size="xs" onClick={() => void load(rows().length > 0)}>
                {t().retry}
              </Button>
            </InlineGuidance>
          </Show>
          <Show when={!busy() && !failed() && rows().length === 0}>
            <p class="chat-channel-catalog__empty" role="status">
              {query().trim() ? t().channelSearchEmpty({ query: query().trim() }) : t().noChannels}
            </p>
          </Show>
          <For each={rows()}>
            {(row) => (
              <AppWorkspace.SidebarItem
                description={channelLine(row, t())}
                meta={
                  <Show when={row.member}>
                    <i class="ti ti-check" role="img" aria-label={t().subscribed} />
                  </Show>
                }
                onClick={() => {
                  props.onClose();
                  props.onOpen(row.id);
                }}
              >
                <AppWorkspace.SidebarItemIcon>
                  <ChatAvatar row={row} />
                </AppWorkspace.SidebarItemIcon>
                <AppWorkspace.SidebarItemLabel marquee={false}>{row.title}</AppWorkspace.SidebarItemLabel>
              </AppWorkspace.SidebarItem>
            )}
          </For>
          <Show when={cursor()}>
            <Button variant="text" size="sm" loading={busy()} onClick={() => void load(true)}>
              {t().showMoreChannels}
            </Button>
          </Show>
        </div>
      </div>
    </AnchoredPopover>
  );
}
