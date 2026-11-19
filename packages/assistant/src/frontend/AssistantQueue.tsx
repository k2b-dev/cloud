import type { AiMessageOrigin } from "@k2b/cloud/ai/browser";
import { dates } from "@k2b/stdlib";
import { IconButton, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { queueMessages } from "./queue-messages";

/** Who wrote a queued message, as the server projects it for the viewer; `href` only where the viewer may open it. */
export type AssistantQueueOrigin = AiMessageOrigin;

/** One queued message, in the order the server received it. */
export type AssistantQueueEntry = {
  id: string;
  text: string;
  origin: AssistantQueueOrigin;
  state: "pending" | "sending" | "failed";
  authorIsViewer: boolean;
  error?: string | null;
  retrying?: boolean;
};

export type AssistantQueueProps = {
  entries: readonly AssistantQueueEntry[];
  /** `line`: the row above the field shows the next entry; `chip`: it shares the row with "Waiting for you". */
  layout: "line" | "chip";
  timeZone?: string;
  /** The entry whose "Send now" runs on this device. */
  sendingId: string | null;
  /** Entries whose "Send now" failed, or ended unclear and was not sent, on this device. */
  failedIds: ReadonlySet<string>;
  /** Another change of the queue runs, such as removing an entry. */
  busy: boolean;
  onSendNow: (entry: AssistantQueueEntry) => void;
  onEdit: (entry: AssistantQueueEntry) => void;
  onRemove: (entry: AssistantQueueEntry) => void;
};

type EntryState = "pending" | "sending" | "failed";

const ORIGIN_ICON: Record<AssistantQueueOrigin["kind"] | "own", string> = {
  own: "ti ti-corner-down-right",
  person: "ti ti-user",
  automation: "ti ti-feat-code",
  wakeup: "ti ti-alarm",
  chat: "ti ti-sparkles",
};

/**
 * Queued messages ("Vorgemerkt", Gustav chat Feinschliff v6, 6b). One 32 px row above the field previews the next entry
 * and "+n"; it has no actions, so it is never unclear which message one would send. A press opens the list over the row:
 * one 36 px row per entry with its source sign, the text cut at 56 characters, its source right behind it, and a fixed
 * place for three sign buttons (edit only one's own, send now, remove) that show on the row under the pointer or with
 * focus. Neither the row nor the list moves the field or the conversation: both lie over the timeline's free end.
 */
export default function AssistantQueue(props: AssistantQueueProps) {
  const locale = useLocale();
  const t = () => queueMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let toggle: HTMLButtonElement | undefined;
  const listId = `assistant-queue-${Math.random().toString(36).slice(2, 10)}`;

  const stateOf = (entry: AssistantQueueEntry): EntryState =>
    props.sendingId === entry.id || entry.state === "sending"
      ? "sending"
      : props.failedIds.has(entry.id) || entry.state === "failed"
        ? "failed"
        : "pending";
  const locked = createMemo(() => props.busy || props.entries.some((entry) => stateOf(entry) === "sending"));
  const origin = (entry: AssistantQueueEntry): string | null => {
    if (entry.authorIsViewer) return null;
    const source = entry.origin;
    if (source.kind === "wakeup")
      return `${source.name} ${dates.formatTime(source.scheduledAt, { locale: locale(), timeZone: props.timeZone ?? "UTC" })}`;
    return source.kind === "automation"
      ? t().fromAutomation({ name: source.name })
      : source.kind === "chat"
        ? t().fromChat({ name: source.name })
        : source.name;
  };
  const icon = (entry: AssistantQueueEntry) => (entry.authorIsViewer ? "own" : entry.origin.kind);
  const next = () => props.entries[0];

  const close = (focusToggle: boolean) => {
    if (!open()) return;
    setOpen(false);
    if (focusToggle) toggle?.focus();
  };
  // Escape closes and gives the focus back; a press outside closes in place.
  createEffect(() => {
    if (!open()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    });
  });
  // An entry that leaves the list while it holds the focus hands it to the toggle, never to the page.
  createEffect(
    on(
      () => props.entries.map((entry) => entry.id).join(" "),
      () => {
        if (props.entries.length === 0) setOpen(false);
        queueMicrotask(() => {
          if (open() && (document.activeElement === document.body || document.activeElement === null)) toggle?.focus();
        });
      },
      { defer: true },
    ),
  );

  // A new entry is announced once; the first list a chat shows is not.
  const [announcement, setAnnouncement] = createSignal("");
  let known: Set<string> | null = null;
  createEffect(() => {
    const ids = new Set(props.entries.map((entry) => entry.id));
    if (known) {
      const added = props.entries.filter((entry) => !known!.has(entry.id)).at(-1);
      if (added) setAnnouncement(t().announce({ text: added.text }));
    }
    known = ids;
  });

  const Main = (mainProps: { entry: AssistantQueueEntry }) => (
    <span class="assistant-queue__main">
      <span class="assistant-queue__text" title={mainProps.entry.text}>
        {mainProps.entry.text}
      </span>
      <Show when={origin(mainProps.entry)}>
        {(label) => (
          <span class="assistant-queue__origin">
            <span aria-hidden="true"> · </span>
            <span class="k2b-sr-only">, </span>
            {label()}
          </span>
        )}
      </Show>
    </span>
  );
  const Sign = (signProps: { entry: AssistantQueueEntry }) => (
    <i class={`assistant-queue__sign ${ORIGIN_ICON[icon(signProps.entry)]}`} data-kind={icon(signProps.entry)} aria-hidden="true" />
  );
  const StateWord = (stateProps: { entry: AssistantQueueEntry }) => (
    <Show when={stateOf(stateProps.entry) !== "pending"}>
      <span class="assistant-queue__state" data-state={stateOf(stateProps.entry)}>
        <Show when={stateOf(stateProps.entry) === "failed"}>
          <i class="ti ti-alert-circle" aria-hidden="true" />
        </Show>
        {stateOf(stateProps.entry) === "sending"
          ? t().sending
          : stateProps.entry.error === "dispatch_failed"
            ? stateProps.entry.retrying
              ? t().dispatchRetrying
              : t().dispatchFailed
            : t().notSent}
      </span>
    </Show>
  );

  const Toggle = () => (
    <button
      ref={toggle}
      type="button"
      class={props.layout === "chip" ? "assistant-queue__chip" : "assistant-queue__all"}
      aria-expanded={open() ? "true" : "false"}
      aria-controls={listId}
      aria-label={props.layout === "line" ? t().showAll({ count: props.entries.length }) : undefined}
      title={props.layout === "line" ? t().showAllShort : undefined}
      onClick={() => setOpen((value) => !value)}
    >
      <Show
        when={props.layout === "chip"}
        fallback={
          <Show when={props.entries.length > 1}>
            <span class="assistant-queue__count">+{props.entries.length - 1}</span>
          </Show>
        }
      >
        {/* Spaces between the parts keep the name "Queued · n"; the flex row does not draw them. */}
        <i class="ti ti-hourglass" aria-hidden="true" /> <span>{t().queued}</span> <span aria-hidden="true">·</span>{" "}
        <span class="assistant-queue__count">{props.entries.length}</span>
      </Show>
      <i class="ti ti-chevron-up assistant-queue__chevron" aria-hidden="true" />
    </button>
  );

  return (
    <div ref={root} class="assistant-queue" data-layout={props.layout} data-open={open() ? "" : undefined}>
      <Show when={props.layout === "line" && next()}>
        {(entry) => (
          <>
            <span class="assistant-queue__head">
              <i class="ti ti-hourglass" aria-hidden="true" />
              {t().queued}
            </span>
            <span class="assistant-queue__next">
              <Sign entry={entry()} />
              <Main entry={entry()} />
            </span>
            <StateWord entry={entry()} />
          </>
        )}
      </Show>
      <Toggle />
      <div class="assistant-queue__list" id={listId} role="group" aria-label={t().queuedMessages} hidden={!open()}>
        <div class="assistant-queue__list-head">
          <span>
            {t().queued} · <span class="assistant-queue__count">{props.entries.length}</span>
          </span>
          <span class="assistant-queue__hint">{t().order}</span>
        </div>
        <ol class="assistant-queue__rows">
          <For each={props.entries}>
            {(entry) => (
              <li class="assistant-queue__row k2b-progressive-row" data-state={stateOf(entry)} data-entry={entry.id}>
                <Sign entry={entry} />
                <Main entry={entry} />
                <StateWord entry={entry} />
                <span class="assistant-queue__actions k2b-progressive-action" data-pinned={stateOf(entry) === "sending" ? "" : undefined}>
                  <Show when={entry.authorIsViewer} fallback={<span class="assistant-queue__slot" />}>
                    <IconButton size="sm" label={t().edit} disabled={locked()} onClick={() => props.onEdit(entry)}>
                      <i class="ti ti-pencil" aria-hidden="true" />
                    </IconButton>
                  </Show>
                  <Show
                    when={stateOf(entry) !== "sending"}
                    fallback={
                      <span class="assistant-queue__busy" role="status" aria-label={t().sending} title={t().sending}>
                        <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
                      </span>
                    }
                  >
                    <IconButton
                      size="sm"
                      label={stateOf(entry) === "failed" ? t().retrySendNow : t().sendNow}
                      disabled={locked()}
                      onClick={() => props.onSendNow(entry)}
                    >
                      <i class="ti ti-send" aria-hidden="true" />
                    </IconButton>
                  </Show>
                  <IconButton size="sm" label={t().remove} disabled={locked()} onClick={() => props.onRemove(entry)}>
                    <i class="ti ti-x" aria-hidden="true" />
                  </IconButton>
                </span>
              </li>
            )}
          </For>
        </ol>
      </div>
      <span class="k2b-sr-only" aria-live="polite">
        {announcement()}
      </span>
    </div>
  );
}
