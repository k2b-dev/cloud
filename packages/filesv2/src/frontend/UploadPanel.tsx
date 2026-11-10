import { text } from "@k2b/stdlib";
import { Button, ButtonLink, FileTypeIcon, IconButton, toast, useLocale } from "@k2b/ui";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { doneFraction, failedFraction, percent, showsFolder, type UploadAnnouncement, type UploadRow } from "./upload-batch";
import { useUploadMessages } from "./upload-messages";
import type { UploadQueue } from "./upload-queue";

const VISIBLE_ROWS = 5;
/** Rows rendered beyond the visible ones, so scrolling never shows a gap. */
const OVERSCAN = 4;
/** A finished upload with "View" stays like a toast with an action; a cancelled one like a plain toast. Failures stay. */
const DONE_MS = 8000;
const CANCELLED_MS = 6000;
/**
 * The remaining time shows only for a long upload. The estimate exists after 3 s of transfer (upload-estimate.ts);
 * the time appears once it first says 10 s or more, and then stays until the batch stops running, also when it later
 * drops below 10 s, so it never flickers. A short upload never shows it.
 */
const LONG_UPLOAD_SECONDS = 10;
/** The usual double-click interval: the batch action ignores a second press that lands this soon after it changed meaning. */
const ACTION_SETTLE_MS = 500;
/** Failures that land this close together are announced as one message. */
const FAILURE_GATHER_MS = 1500;
/** On a phone the panel starts as one line, so the running upload covers little of the screen. */
const PHONE_QUERY = "(max-width: 47.999rem)";

const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const onPhone = () => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

/**
 * Places the upload panel at the edge of the toast rail while its queue holds a batch: toasts stack in front of it,
 * and it can be closed only once nothing runs. Renders nothing in place.
 */
export function UploadSurface<G>(props: { queue: UploadQueue<G> }) {
  const u = useUploadMessages();
  const visible = createMemo(() => props.queue.batch.rows.length > 0);
  createEffect(() => {
    if (!visible()) return;
    const running = () => props.queue.batch.phase === "running";
    const slot = toast.custom((<UploadPanel queue={props.queue} />) as HTMLElement, {
      label: untrack(() => u().name),
      closable: untrack(() => !running()),
      onClose: () => props.queue.close(),
    });
    createEffect(() => slot.update({ closable: !running(), label: u().name }));
    onCleanup(() => slot.dismiss());
  });
  return null;
}

/*
 * One surface for a whole upload batch, in the toast's layout: the icon tile, the title and one summary line, then
 * the byte-weighted total, the files, and the count with the one batch action. Rows have a fixed height and only the
 * visible ones are rendered, so a folder with thousands of files costs a handful of rows.
 */
export function UploadPanel<G>(props: { queue: UploadQueue<G> }): JSX.Element {
  const u = useUploadMessages();
  const locale = useLocale();
  const bytes = (value: number) => text.pprintBytes(value, { locale: locale() });
  const batch = props.queue.batch;
  const titleId = `filesv2-upload-${createUniqueId()}`;
  const listId = `${titleId}-list`;
  const [expanded, setExpanded] = createSignal((batch.phase === "running" && !onPhone()) || batch.phase === "errors");
  const [live, setLive] = createSignal("");
  const value = () => percent(batch);
  const [long, setLong] = createSignal(false);
  createEffect(() => {
    const seconds = props.queue.remainingSeconds();
    if (batch.phase === "running" && seconds !== null && seconds >= LONG_UPLOAD_SECONDS) setLong(true);
  });
  const remaining = () => {
    const seconds = props.queue.remainingSeconds();
    const active = batch.active === null ? null : batch.rows[batch.active];
    if (!long() || !seconds || batch.phase !== "running" || active?.wait || active?.phase) return null;
    return u().remainingTime(seconds);
  };
  const action = createMemo(() => (batch.phase === "running" ? "cancel" : batch.failed ? "retry" : null));
  const title = () => {
    switch (batch.phase) {
      case "running":
        if (batch.active !== null && batch.rows[batch.active]?.wait === "network") return u().waitingForNetwork;
        return batch.target ? u().uploadingTo(batch.target.label) : u().uploading;
      case "done":
        // Every file already existed and was skipped: nothing was uploaded.
        if (!batch.count) return u().nothingUploaded;
        return batch.target ? u().uploadedTo(batch.target.label) : u().uploaded;
      case "errors":
        return u().failedTitle(batch.failed);
      case "cancelled":
        return u().cancelled;
    }
  };
  const count = () => (batch.count || !batch.skipped ? u().count({ done: batch.done, count: batch.count }) : u().allExist(batch.skipped));
  const sent = () => {
    const active = batch.active === null ? null : batch.rows[batch.active];
    return batch.doneBytes + (active ? Math.min(active.sent, active.size) : 0);
  };
  /** The line under the title: bytes while the list shows, the count as one line, and the remaining time of a long upload. */
  const summary = () => {
    if (batch.phase !== "running") return count();
    const line = expanded() ? u().transferred({ sent: bytes(sent()), size: bytes(batch.totalBytes) }) : count();
    const eta = remaining();
    return eta ? `${line} · ${eta}` : line;
  };
  const tone = () => ({ running: "info", done: "success", errors: "danger", cancelled: "info" })[batch.phase];
  const icon = () => ({ running: "ti-upload", done: "ti-check", errors: "ti-alert-circle", cancelled: "ti-circle-minus" })[batch.phase];
  const barTone = () => ({ running: undefined, done: "success", errors: "success", cancelled: "muted" })[batch.phase];
  const view = () => (batch.phase === "done" && batch.count ? (batch.target?.href ?? null) : null);

  // One polite live region. It hears changes of state (start, files added, a failure, offline and back, the summary),
  // never progress.
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string) => {
    setLive("");
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => setLive(text), 60);
  };
  let failures: Extract<UploadAnnouncement, { kind: "failed" }>[] = [];
  let failureTimer: ReturnType<typeof setTimeout> | undefined;
  const sayFailures = () => {
    const gathered = failures;
    failures = [];
    if (gathered.length === 1) say(u().announce(gathered[0]!));
    else if (gathered.length > 1) say(u().announce({ kind: "failures", count: gathered.length }));
  };
  const stop = props.queue.listen((said) => {
    if (said.kind === "progress") return;
    if (said.kind === "failed") {
      failures.push(said);
      clearTimeout(failureTimer);
      failureTimer = setTimeout(sayFailures, FAILURE_GATHER_MS);
      return;
    }
    if (said.kind === "finished" || said.kind === "cancelled") {
      // The summary names the failures too.
      clearTimeout(failureTimer);
      failures = [];
    }
    say(u().announce(said));
  });
  onMount(() => say(u().announce({ kind: "started", count: batch.count })));
  onCleanup(() => {
    stop();
    clearTimeout(announceTimer);
    clearTimeout(failureTimer);
  });

  // Only the rows in view exist; the list keeps the full height so the scrollbar tells the size of the batch.
  let scroll: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const rowHeight = () => scroll?.querySelector("li")?.getBoundingClientRect().height || 36;
  const rendered = createMemo(() => {
    const height = rowHeight();
    const first = Math.max(0, Math.floor(scrollTop() / height) - OVERSCAN);
    const last = Math.min(batch.rows.length, Math.ceil(scrollTop() / height) + VISIBLE_ROWS + OVERSCAN);
    return Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index);
  });

  // The list follows the file in flight and keeps one row above it, until a pointer or focus is inside it.
  const [pointerInside, setPointerInside] = createSignal(false);
  const [focusInside, setFocusInside] = createSignal(false);
  const showRow = (id: number) => {
    if (!scroll || !expanded()) return;
    const top = Math.max(0, (id - 1) * rowHeight());
    if (typeof scroll.scrollTo === "function") scroll.scrollTo({ top, behavior: reducedMotion() ? "auto" : "smooth" });
    else scroll.scrollTop = top;
  };
  const follow = () => {
    if (!pointerInside() && !focusInside() && batch.active !== null) showRow(batch.active);
  };
  createEffect(on(() => batch.active, follow));
  createEffect(
    on(
      () => batch.phase,
      (phase) => {
        // A new run measures its own remaining time.
        setLong(false);
        if (phase === "done" || phase === "cancelled") setExpanded(false);
        if (phase === "running") setExpanded(!onPhone());
        if (phase !== "errors") return;
        // The batch ends with failures: the list opens on the first of them.
        setExpanded(true);
        const first = batch.rows.find((row) => row.status === "failed");
        if (first) requestAnimationFrame(() => showRow(first.id));
      },
      { defer: true },
    ),
  );

  // A finished upload leaves after its time, unless a pointer or focus is on the panel. Failures stay.
  const [hot, setHot] = createSignal(false);
  createEffect(() => {
    if (hot() || batch.failed || (batch.phase !== "done" && batch.phase !== "cancelled")) return;
    const timer = setTimeout(() => props.queue.close(), batch.phase === "done" ? DONE_MS : CANCELLED_MS);
    onCleanup(() => clearTimeout(timer));
  });

  // WebKit sends no pointerleave when the element under a resting pointer leaves the document, and rows change under
  // it all the time. The next pointerover tells where the pointer went, so a lost leave neither stops the list from
  // following nor keeps a finished panel open.
  let panel: HTMLElement | undefined;
  onMount(() => {
    const pointerOver = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (pointerInside() && !scroll?.contains(target)) {
        setPointerInside(false);
        follow();
      }
      if (hot() && !panel?.contains(target)) setHot(!!panel?.contains(document.activeElement));
    };
    document.addEventListener("pointerover", pointerOver, true);
    onCleanup(() => document.removeEventListener("pointerover", pointerOver, true));
  });

  // A double-click on "Try again" must not land its second click on the "Cancel all" the first one turned it into.
  let actionChanged = Number.NEGATIVE_INFINITY;
  createEffect(on(action, () => (actionChanged = performance.now()), { defer: true }));
  const runAction = () => {
    if (performance.now() - actionChanged < ACTION_SETTLE_MS) return;
    if (action() === "cancel") props.queue.cancel();
    else props.queue.retry();
  };
  /** The slot's round close button, which appears once nothing runs. */
  const closeButton = () => panel?.closest("[data-k2b-toast]")?.querySelector<HTMLButtonElement>(":scope > .k2b-toast__close") ?? null;

  const toggle = () => {
    setExpanded(!expanded());
    if (expanded() && batch.active !== null) requestAnimationFrame(() => showRow(batch.active!));
  };

  return (
    <section
      ref={panel}
      class="filesv2-upload"
      data-phase={batch.phase}
      data-expanded={String(expanded())}
      aria-labelledby={titleId}
      onPointerEnter={() => setHot(true)}
      onPointerLeave={(event) => setHot(event.currentTarget.contains(document.activeElement))}
      onFocusIn={() => setHot(true)}
      onFocusOut={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHot(event.currentTarget.matches(":hover"));
      }}
    >
      <div class="filesv2-upload__head">
        <span class="k2b-toast__icon k2b-icon-tile filesv2-upload__icon" data-tone={tone()} aria-hidden="true">
          <i class={`ti ${icon()}`} />
        </span>
        <div class="filesv2-upload__text">
          <h2 class="k2b-toast__title filesv2-upload__title" id={titleId}>
            {title()}
          </h2>
          <p class="k2b-toast__description filesv2-upload__summary">{summary()}</p>
        </div>
        <div class="filesv2-upload__end">
          <Show when={view()}>
            {(href) => (
              <ButtonLink
                href={href()}
                navigation="enhanced"
                size="sm"
                variant="secondary"
                aria-label={batch.target ? u().viewFolder(batch.target.label) : undefined}
                onClick={() => props.queue.close()}
              >
                {u().view}
              </ButtonLink>
            )}
          </Show>
          <Show when={batch.phase === "running" || batch.phase === "errors"}>
            <IconButton
              size="sm"
              class="filesv2-upload__toggle"
              label={expanded() ? u().hideList : u().showList}
              aria-expanded={expanded()}
              aria-controls={listId}
              onClick={toggle}
            >
              <i class="ti ti-chevron-down" aria-hidden="true" />
            </IconButton>
          </Show>
        </div>
      </div>
      <div
        class="k2b-toast__bar filesv2-upload__bar"
        role="progressbar"
        aria-label={u().bar}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={value()}
        aria-valuetext={u().valueText({ percent: value(), done: batch.done, count: batch.count })}
      >
        <span
          class="k2b-toast__bar-fill filesv2-upload__bar-done"
          data-tone={barTone()}
          style={{ "--k2b-toast-bar-value": String(doneFraction(batch)) }}
        />
        <span
          class="k2b-toast__bar-fill filesv2-upload__bar-failed"
          data-tone="danger"
          style={{ "--k2b-toast-bar-start": String(doneFraction(batch)), "--k2b-toast-bar-value": String(failedFraction(batch)) }}
        />
      </div>
      <div
        ref={scroll}
        id={listId}
        class="filesv2-upload__scroll"
        role="region"
        aria-label={u().list}
        tabIndex={0}
        style={{ "--filesv2-upload-visible": Math.min(VISIBLE_ROWS, batch.rows.length) }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onPointerEnter={() => setPointerInside(true)}
        onPointerLeave={() => {
          setPointerInside(false);
          follow();
        }}
        onFocusIn={() => setFocusInside(true)}
        onFocusOut={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setFocusInside(false);
          follow();
        }}
      >
        <ol class="filesv2-upload__list" style={{ "--filesv2-upload-rows": batch.rows.length }}>
          <For each={rendered()}>
            {(id) => (
              <UploadRowView
                row={batch.rows[id]!}
                folder={showsFolder(batch, batch.rows[id]!)}
                total={batch.rows.length}
                onRetry={(event) => {
                  props.queue.retry([id]);
                  // The retry button leaves with the failure; keyboard focus stays in the list. A pointer leaves focus
                  // alone, so the list keeps following the file in flight.
                  if (event.detail === 0) scroll?.focus();
                }}
              />
            )}
          </For>
        </ol>
      </div>
      <div class="filesv2-upload__foot">
        <p class="filesv2-upload__count">{count()}</p>
        <Show when={batch.failed && batch.phase !== "errors"}>
          <p class="filesv2-upload__errors">{u().errors(batch.failed)}</p>
        </Show>
        <Show when={action()}>
          {(_) => {
            let button: HTMLButtonElement | undefined;
            // When the action leaves with focus on it, focus moves to the close button that appears, not the page.
            onCleanup(() => {
              if (document.activeElement === button) queueMicrotask(() => closeButton()?.focus());
            });
            return (
              <Button
                ref={button}
                variant={action() === "cancel" ? "secondary" : "primary"}
                size="sm"
                class="filesv2-upload__action"
                aria-label={action() === "cancel" ? u().cancelUpload : u().retryAll(batch.failed)}
                onClick={runAction}
              >
                {action() === "cancel" ? u().cancelAll : u().retry}
              </Button>
            );
          }}
        </Show>
      </div>
      <div class="k2b-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {live()}
      </div>
    </section>
  );
}

function UploadRowView(props: { row: UploadRow; folder: boolean; total: number; onRetry: (event: MouseEvent) => void }) {
  const u = useUploadMessages();
  const locale = useLocale();
  const bytes = (value: number) => text.pprintBytes(value, { locale: locale() });
  // A wait for the network or a busy server says more than the publication in progress; a new try does not.
  const finishing = () =>
    props.row.status === "working" && props.row.phase === "finishing" && (!props.row.wait || props.row.wait === "retrying");
  const note = () =>
    props.row.status !== "working" ? props.row.reason : finishing() ? u().finishing : props.row.wait ? u().wait(props.row.wait) : null;
  const share = () => (props.row.size ? Math.min(1, props.row.sent / props.row.size) : 0);
  const hint = () => (
    <>
      <strong>{props.row.reason}</strong> {u().retryHint}
    </>
  );
  return (
    <li
      class="filesv2-upload-row"
      data-status={props.row.status}
      data-wait={props.row.status === "working" ? (props.row.wait ?? undefined) : undefined}
      data-phase={props.row.status === "working" ? (props.row.phase ?? undefined) : undefined}
      style={{ "--filesv2-upload-index": props.row.id }}
      aria-posinset={props.row.id + 1}
      aria-setsize={props.total}
    >
      <FileTypeIcon name={props.row.name} size="sm" class="filesv2-upload-row__icon" />
      <span class="filesv2-upload-row__text">
        <span class="filesv2-upload-row__name">
          <Show when={props.row.path.includes("/")}>
            <Show when={props.folder} fallback={<span class="k2b-sr-only">{folderOf(props.row.path)}</span>}>
              <span class="filesv2-upload-row__folder">{folderOf(props.row.path)}</span>
            </Show>
          </Show>
          <span class="filesv2-upload-row__base">{props.row.name}</span>
          <span class="k2b-sr-only">, {finishing() ? u().finishingStatus : u().status(props.row.status)}</span>
        </span>
        {/* Every row has its second line, so a wait or Finishing… replaces the bytes without moving the name. */}
        <Show
          when={(props.row.status === "failed" || props.row.status === "working") && note()}
          fallback={
            <span class="filesv2-upload-row__progress" aria-hidden="true">
              {props.row.status === "working"
                ? u().transferred({ sent: bytes(props.row.sent), size: bytes(props.row.size) })
                : bytes(props.row.size)}
            </span>
          }
        >
          <span class="filesv2-upload-row__reason">{note()}</span>
        </Show>
      </span>
      <span class="filesv2-upload-row__status">
        <Switch>
          <Match when={props.row.status === "working" && props.row.wait !== null && props.row.wait !== "retrying"}>
            <i class={`ti ${props.row.wait === "network" ? "ti-wifi-off" : "ti-clock-pause"}`} aria-hidden="true" />
          </Match>
          <Match when={props.row.status === "working"}>
            <span class="k2b-toast__bar filesv2-upload-row__bar" aria-hidden="true">
              <span class="k2b-toast__bar-fill" style={{ "--k2b-toast-bar-value": String(share()) }} />
            </span>
            <span class="filesv2-upload-row__percent" aria-hidden="true">
              {u().percent(Math.round(share() * 100))}
            </span>
          </Match>
          <Match when={props.row.status === "failed"}>
            <IconButton size="sm" label={u().retryFile(props.row.name)} tooltip={hint()} onClick={props.onRetry}>
              <i class="ti ti-refresh" aria-hidden="true" />
            </IconButton>
          </Match>
          <Match when={props.row.status === "pending"}>
            <span class="filesv2-upload-row__waiting" aria-hidden="true">
              {u().status("pending")}
            </span>
          </Match>
          <Match when={props.row.status}>
            {(status) => (
              <i
                class={`ti ${
                  {
                    pending: "",
                    success: "ti-check",
                    skipped: "ti-circle-dashed-check",
                    cancelled: "ti-circle-minus",
                    working: "",
                    failed: "",
                  }[status()]
                }`}
                aria-hidden="true"
              />
            )}
          </Match>
        </Switch>
      </span>
    </li>
  );
}
