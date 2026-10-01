import { Button, IconButton, ProgressRing, Tooltip, toast } from "@k2b/ui";
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
} from "solid-js";
import { doneFraction, failedFraction, percent, showsFolder, type UploadAnnouncement, type UploadRow } from "./upload-batch";
import { useUploadMessages } from "./upload-messages";
import type { UploadQueue } from "./upload-queue";

const VISIBLE_ROWS = 5;
/** Rows rendered beyond the visible ones, so scrolling never shows a gap. */
const OVERSCAN = 4;
const DISMISS_MS = 5000;
/** Failures that land this close together are announced as one message. */
const FAILURE_GATHER_MS = 1500;

const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Places the upload panel in the toast rail while its queue holds a batch, so it shares the corner with other
 * toasts instead of covering them. Renders nothing in place.
 */
export function UploadSurface<G>(props: { queue: UploadQueue<G> }) {
  const visible = createMemo(() => props.queue.batch.rows.length > 0);
  createEffect(() => {
    if (!visible()) return;
    const slot = toast.custom((<UploadPanel queue={props.queue} />) as HTMLElement);
    onCleanup(() => slot.dismiss());
  });
  return null;
}

/*
 * One calm surface for a whole upload batch: the byte-weighted total first, then the files, then the count and
 * the one batch action. Rows have a fixed height and only the visible ones are rendered, so a folder with
 * thousands of files costs a handful of rows.
 */
export function UploadPanel<G>(props: { queue: UploadQueue<G> }): JSX.Element {
  const u = useUploadMessages();
  const batch = props.queue.batch;
  const titleId = `filesv2-upload-${createUniqueId()}`;
  const listId = `${titleId}-list`;
  const [expanded, setExpanded] = createSignal(batch.phase === "running" || batch.phase === "errors");
  const [live, setLive] = createSignal("");
  const value = () => percent(batch);
  const action = () => (batch.phase === "running" ? "cancel" : batch.failed ? "retry" : null);
  const title = () => {
    switch (batch.phase) {
      case "running":
        return batch.target ? u().uploadingTo(batch.target.label) : u().uploading;
      case "done":
        return batch.target ? u().uploadedTo(batch.target.label) : u().uploaded;
      case "errors":
        return u().failedTitle(batch.failed);
      case "cancelled":
        return u().cancelled;
    }
  };

  // One polite live region. It hears milestones, appends, failures and the summary, never single percent steps.
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
        if (phase === "done") setExpanded(false);
        if (phase === "running") setExpanded(true);
        if (phase !== "errors") return;
        // The batch ends with failures: the list opens on the first of them.
        setExpanded(true);
        const first = batch.rows.find((row) => row.status === "failed");
        if (first) requestAnimationFrame(() => showRow(first.id));
      },
      { defer: true },
    ),
  );

  // A quiet success leaves after five seconds, unless a pointer or focus is on the panel. Failures stay.
  const [hot, setHot] = createSignal(false);
  createEffect(() => {
    if (hot() || batch.failed || (batch.phase !== "done" && batch.phase !== "cancelled")) return;
    const timer = setTimeout(() => props.queue.close(), DISMISS_MS);
    onCleanup(() => clearTimeout(timer));
  });

  const toggle = () => {
    setExpanded(!expanded());
    if (expanded() && batch.active !== null) requestAnimationFrame(() => showRow(batch.active!));
  };

  return (
    <section
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
        <Show when={batch.phase === "running"}>
          <span class="filesv2-upload__percent" aria-hidden="true">
            {u().percent(value())}
          </span>
        </Show>
        <h2 class="filesv2-upload__title" id={titleId}>
          {title()}
        </h2>
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
        <Show when={batch.phase !== "running"}>
          <IconButton size="sm" label={u().dismiss} onClick={() => props.queue.close()}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        </Show>
      </div>
      <div
        class="filesv2-upload__bar"
        role="progressbar"
        aria-label={u().bar}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={value()}
        aria-valuetext={u().valueText({ percent: value(), done: batch.done, count: batch.count })}
      >
        <span class="filesv2-upload__bar-done" style={{ width: `${doneFraction(batch) * 100}%` }} />
        <span class="filesv2-upload__bar-failed" style={{ width: `${failedFraction(batch) * 100}%` }} />
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
                onRetry={() => {
                  props.queue.retry([id]);
                  // The retry button leaves with the failure; keep keyboard focus in the list.
                  scroll?.focus();
                }}
              />
            )}
          </For>
        </ol>
      </div>
      <div class="filesv2-upload__foot">
        <p class="filesv2-upload__count">{u().count({ done: batch.done, count: batch.count })}</p>
        <Show when={batch.failed && batch.phase !== "errors"}>
          <p class="filesv2-upload__errors">{u().errors(batch.failed)}</p>
        </Show>
        <Show when={action()}>
          <Button
            variant="text"
            size="xs"
            class="filesv2-upload__action"
            aria-label={action() === "cancel" ? u().cancelUpload : u().retryAll(batch.failed)}
            onClick={() => (action() === "cancel" ? props.queue.cancel() : props.queue.retry())}
          >
            {action() === "cancel" ? u().cancel : u().retry}
          </Button>
        </Show>
      </div>
      <div class="k2b-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {live()}
      </div>
    </section>
  );
}

function UploadRowView(props: { row: UploadRow; folder: boolean; total: number; onRetry: () => void }) {
  const u = useUploadMessages();
  const hint = () => (
    <>
      <strong>{props.row.reason}</strong> {u().retryHint}
    </>
  );
  return (
    <li
      class="filesv2-upload-row"
      data-status={props.row.status}
      style={{ "--filesv2-upload-index": props.row.id }}
      aria-posinset={props.row.id + 1}
      aria-setsize={props.total}
    >
      <span class="filesv2-upload-row__status">
        <Switch>
          <Match when={props.row.status === "working"}>
            <ProgressRing value={props.row.size ? (props.row.sent / props.row.size) * 100 : 0} />
          </Match>
          <Match when={props.row.status === "failed"}>
            <Tooltip.Anchor content={hint()}>
              <i class="ti ti-alert-triangle" aria-hidden="true" />
            </Tooltip.Anchor>
          </Match>
          <Match when={props.row.status}>
            {(status) => (
              <i
                class={`ti ${
                  {
                    pending: "ti-clock",
                    success: "ti-circle-check",
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
      <span class="filesv2-upload-row__text">
        <span class="filesv2-upload-row__name">
          <Show when={props.row.path.includes("/")}>
            <Show when={props.folder} fallback={<span class="k2b-sr-only">{folderOf(props.row.path)}</span>}>
              <span class="filesv2-upload-row__folder">{folderOf(props.row.path)}</span>
            </Show>
          </Show>
          <span class="filesv2-upload-row__base">{props.row.name}</span>
          <span class="k2b-sr-only">, {u().status(props.row.status)}</span>
        </span>
        <Show when={props.row.status === "failed"}>
          <span class="filesv2-upload-row__reason">{props.row.reason}</span>
        </Show>
      </span>
      <Show when={props.row.status === "failed"}>
        <IconButton size="sm" label={u().retryFile(props.row.name)} tooltip={hint()} onClick={props.onRetry}>
          <i class="ti ti-refresh" aria-hidden="true" />
        </IconButton>
      </Show>
    </li>
  );
}
