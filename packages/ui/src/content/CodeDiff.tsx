import { children, createEffect, createMemo, createSignal, For, type JSX, Match, on, Show, Switch, untrack } from "solid-js";
import { Button } from "../actions/Button";
import { Tabs } from "../actions/Tabs";
import { Tooltip } from "../feedback/Tooltip";
import { useLocale } from "../intl/locale";
import Placeholder from "../surfaces/Placeholder";
import { Skeleton } from "../surfaces/Skeleton";
import { useCodeDiffMessages } from "./code-diff-messages";
import { type CodeDisplayLanguage, highlightCodeDisplayLines } from "./code-highlight";

/** `same` is in both versions, `add` only in the new one, `del` only in the old one. */
export type CodeDiffLineKind = "same" | "add" | "del";

export type CodeDiffLine = { kind: CodeDiffLineKind; text: string };

/**
 * Centres a row in its nearest vertical scroller and moves nothing else. `scrollIntoView` would also scroll every outer
 * container, such as the app shell around a review, and cut its sidebar and list.
 */
const centerInScroller = (row: HTMLElement | null | undefined) => {
  if (!row) return;
  const document = row.ownerDocument;
  const view = document.defaultView;
  let scroller = row.parentElement;
  // The root and the body scroll the viewport, whose origin is 0 however far the page has scrolled.
  while (scroller && scroller !== document.documentElement && scroller !== document.body) {
    const overflow = view?.getComputedStyle(scroller).overflowY ?? "";
    if ((overflow === "auto" || overflow === "scroll") && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  if (scroller === document.documentElement || scroller === document.body) scroller = null;
  const target = scroller ?? document.scrollingElement;
  if (!target) return;
  const top = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
  const height = scroller ? scroller.clientHeight : (view?.innerHeight ?? 0);
  const box = row.getBoundingClientRect();
  target.scrollBy?.({ top: box.top + box.height / 2 - (top + height / 2), behavior: "instant" });
};

export type CodeDiffFile = {
  /** Shown on the file tab and used to address the file. */
  path: string;
  /** The whole file in order. Old and new line numbers are counted from these rows. */
  lines: readonly CodeDiffLine[];
  /** Highlighting mode; defaults from the path extension, else plain text. */
  language?: CodeDisplayLanguage;
};

/** One line of one file. `side: "old"` addresses a removed line by its old number. */
export type CodeDiffLocation = { path: string; line: number; side?: "new" | "old" };

/**
 * One action on every line of the new version, such as "Comment on line 3". It sits in a fixed place between the line
 * number and the code; removed lines have none. Callbacks get the line by its new number, with `side: "new"`.
 */
export type CodeDiffLineAction = {
  /** Accessible name and tooltip of the action, such as "Comment on line 3". */
  label: (location: CodeDiffLocation) => string;
  onSelect: (location: CodeDiffLocation) => void;
};

export type CodeDiffProps = {
  files: readonly CodeDiffFile[];
  /** Shows and marks one line: switches to its file, opens the folded region around it, and scrolls it into view. */
  mark?: CodeDiffLocation;
  /** Controlled file path. Without it the component keeps the choice itself, starting at `mark` or the first file. */
  file?: string;
  onFileChange?: (path: string) => void;
  /** Data the application is still fetching, or failed to fetch. */
  status?: "loading" | "error";
  /** What the failure means for the person, below the error title. */
  errorDescription?: JSX.Element;
  onRetry?: () => void;
  /** Accessible name of the code region. */
  label?: string;
  /**
   * Controls at the start of the file row, such as a version picker. They stay in place, with the file names, while
   * the code loads or fails.
   */
  toolbarStart?: JSX.Element;
  /** An action on each line of the new version. The code is then one tab stop: arrow keys, Home and End move between lines. */
  lineAction?: CodeDiffLineAction;
  /**
   * Lines of the new version with content in their place below the line, such as a comment thread. A listed line is
   * marked and tinted, never folds away, and its page renders. The list is reactive; the content is not rebuilt while
   * its line stays listed.
   */
  slotLines?: readonly CodeDiffLocation[];
  /**
   * The content below a listed line, at the width of the view. Called once while the line is listed, outside any
   * tracking scope, so the content keeps its own state; it reads its own data reactively.
   */
  lineSlot?: (location: CodeDiffLocation) => JSX.Element;
  class?: string;
};

/** Unchanged lines kept around every change; longer unchanged runs fold. */
const CONTEXT = 3;
/** Rows rendered per page; the rest waits behind "Show more", so a large file never renders at once. */
const PAGE = 400;
const LOADING_ROWS = 8;

type Row = { kind: CodeDiffLineKind; html: string; old?: number; new?: number };
type Item = { type: "row"; index: number } | { type: "fold"; start: number; count: number } | { type: "note" };

const EXTENSION_LANGUAGES: Record<string, CodeDisplayLanguage> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  md: "markdown",
  sql: "sql",
  sh: "script",
};

const languageOf = (file: CodeDiffFile): CodeDisplayLanguage =>
  file.language ?? EXTENSION_LANGUAGES[file.path.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

const rowsOf = (file: CodeDiffFile): Row[] => {
  const html = highlightCodeDisplayLines(file.lines.map((line) => line.text).join("\n"), languageOf(file));
  let oldNo = 0;
  let newNo = 0;
  return file.lines.map((line, index) => ({
    kind: line.kind,
    html: html[index] ?? "",
    old: line.kind === "add" ? undefined : ++oldNo,
    new: line.kind === "del" ? undefined : ++newNo,
  }));
};

/** A file with only added rows has no predecessor: it reads as whole code, one number column, no signs. */
const isNewFile = (file: CodeDiffFile) => file.lines.length > 0 && file.lines.every((line) => line.kind === "add");

const hasChanges = (file: CodeDiffFile) => file.lines.some((line) => line.kind !== "same");

/**
 * Visible rows and folds: changes with CONTEXT rows around them; unchanged runs of two or more rows fold. Kept rows
 * (lines with content below them) never fold. A file without changes but with kept rows shows a note and those rows.
 */
const itemsOf = (rows: readonly Row[], open: ReadonlySet<number>, whole: boolean, keep: ReadonlySet<number>): Item[] => {
  if (whole) return rows.map((_, index) => ({ type: "row", index }));
  if (keep.size > 0 && rows.every((row) => row.kind === "same"))
    return [{ type: "note" }, ...[...keep].sort((a, b) => a - b).map((index): Item => ({ type: "row", index }))];
  const distance = new Array<number>(rows.length).fill(Number.POSITIVE_INFINITY);
  let last = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index]!.kind !== "same") last = index;
    distance[index] = index - last;
  }
  last = Number.POSITIVE_INFINITY;
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index]!.kind !== "same") last = index;
    distance[index] = Math.min(distance[index]!, last - index);
  }
  const items: Item[] = [];
  let index = 0;
  while (index < rows.length) {
    if (distance[index]! <= CONTEXT || keep.has(index)) {
      items.push({ type: "row", index });
      index++;
      continue;
    }
    let end = index;
    while (end < rows.length && distance[end]! > CONTEXT && !keep.has(end)) end++;
    if (end - index < 2 || open.has(index)) for (let row = index; row < end; row++) items.push({ type: "row", index: row });
    else items.push({ type: "fold", start: index, count: end - index });
    index = end;
  }
  return items;
};

/** Read-only line diff of one or more files. The application computes the rows; this component only displays them. */
export function CodeDiff(props: CodeDiffProps): JSX.Element {
  const messages = useCodeDiffMessages();
  const locale = useLocale();
  const toolbar = children(() => props.toolbarStart);
  const count = (value: number) => new Intl.NumberFormat(locale()).format(value);

  const [chosen, setChosen] = createSignal<string>();
  const [opened, setOpened] = createSignal<ReadonlyMap<string, ReadonlySet<number>>>(new Map());
  const [pages, setPages] = createSignal<ReadonlyMap<string, number>>(new Map());
  const [focusRow, setFocusRow] = createSignal<number>();
  let body: HTMLDivElement | undefined;

  const currentPath = () => {
    const paths = props.files.map((file) => file.path);
    const wanted = props.file ?? chosen() ?? props.mark?.path;
    return wanted && paths.includes(wanted) ? wanted : paths[0];
  };
  const current = createMemo(() => props.files.find((file) => file.path === currentPath()));
  const rows = createMemo(() => {
    const file = current();
    return file ? rowsOf(file) : [];
  });
  const whole = () => {
    const file = current();
    return file ? isNewFile(file) : false;
  };
  // The place for the line action and the slot marker exists whenever the host may use it, so a first slot moves nothing.
  const annotated = () => props.lineAction !== undefined || props.lineSlot !== undefined;
  /** Rows of the current file that have content below them. */
  const keep = createMemo(() => {
    const path = currentPath();
    const lines = new Set((props.slotLines ?? []).filter((line) => line.path === path && line.side !== "old").map((line) => line.line));
    const indexes = new Set<number>();
    rows().forEach((row, index) => {
      if (row.kind !== "del" && lines.has(row.new!)) indexes.add(index);
    });
    return indexes;
  });
  const markIndex = createMemo(() => {
    const mark = props.mark;
    if (!mark || mark.path !== currentPath()) return undefined;
    const index = rows().findIndex((row) => (mark.side === "old" ? row.old === mark.line && row.kind !== "add" : row.new === mark.line));
    return index >= 0 ? index : undefined;
  });
  // The fold that hides the marked line opens without a click, also in the server render.
  const markFold = createMemo(() => {
    const target = markIndex();
    if (target === undefined) return undefined;
    const plain = itemsOf(rows(), opened().get(currentPath() ?? "") ?? new Set(), whole(), keep());
    const fold = plain.find((item) => item.type === "fold" && target >= item.start && target < item.start + item.count);
    return fold?.type === "fold" ? fold.start : undefined;
  });
  // Items keep their identity while they stay, so a row and the content below it are not rebuilt when a fold opens or a
  // slot comes or goes elsewhere. A line renders the row it was built for, so this holds only while the rows stay the
  // same: another file or another comparison of the same file builds its lines anew.
  let itemCache = new Map<string, Item>();
  let cacheRows: readonly Row[] = [];
  const items = createMemo(() => {
    const all = rows();
    if (all !== cacheRows) itemCache = new Map();
    cacheRows = all;
    const open = new Set(opened().get(currentPath() ?? ""));
    const fold = markFold();
    if (fold !== undefined) open.add(fold);
    const next = new Map<string, Item>();
    const result = itemsOf(all, open, whole(), keep()).map((item) => {
      const key = item.type === "row" ? `r${item.index}` : item.type === "fold" ? `f${item.start}:${item.count}` : "n";
      const kept = itemCache.get(key) ?? item;
      next.set(key, kept);
      return kept;
    });
    itemCache = next;
    return result;
  });
  /** Pages render cumulatively: the pages up to the last row that passes the test. */
  const pagesUpTo = (test: (index: number) => boolean) =>
    Math.ceil((items().findLastIndex((item) => item.type === "row" && test(item.index)) + 1) / PAGE);
  // A marked line renders the pages up to its own, and so does every line with content below it.
  const markPages = createMemo(() => pagesUpTo((index) => index === markIndex()));
  const keepPages = createMemo(() => pagesUpTo((index) => keep().has(index)));
  const shown = createMemo(() =>
    Math.min(items().length, Math.max(pages().get(currentPath() ?? "") ?? 1, markPages(), keepPages()) * PAGE),
  );
  const visible = createMemo(() => items().slice(0, shown()));

  const choose = (path: string) => {
    setChosen(path);
    props.onFileChange?.(path);
  };
  const openFold = (start: number) => {
    const path = currentPath() ?? "";
    setOpened((current) => new Map(current).set(path, new Set([...(current.get(path) ?? []), start])));
    setFocusRow(start);
  };
  const nextPage = () => {
    const path = currentPath() ?? "";
    const first = visible().length;
    setPages((current) => new Map(current).set(path, Math.ceil(shown() / PAGE) + 1));
    const item = items()[first];
    // A note only ever opens the list, so the next page starts with a row or a fold.
    if (item && item.type !== "note") setFocusRow(item.type === "row" ? item.index : item.start);
  };

  // A mark switches to its file, also when that file arrives later. Afterwards the person may choose another file.
  createEffect(
    on(
      () => {
        const mark = props.mark;
        return mark && props.files.some((file) => file.path === mark.path)
          ? `${mark.path}\u0000${mark.side ?? "new"}\u0000${mark.line}`
          : undefined;
      },
      (key) => {
        const path = props.mark?.path;
        if (!key || !path) return;
        const before = currentPath();
        setChosen(path);
        if (path !== before) props.onFileChange?.(path);
      },
    ),
  );
  // What a mark revealed stays revealed when the mark goes away; the marked line scrolls into view. A new mark object
  // is a new request, so marking the same line again brings it back after the person scrolled away.
  createEffect(
    on(
      () => [markIndex(), currentPath(), props.mark] as const,
      ([target, path]) => {
        if (target === undefined || !path) return;
        const fold = markFold();
        const needed = markPages();
        if (fold !== undefined) setOpened((current) => new Map(current).set(path, new Set([...(current.get(path) ?? []), fold])));
        if (needed > (pages().get(path) ?? 1)) setPages((current) => new Map(current).set(path, needed));
        queueMicrotask(() => centerInScroller(body?.querySelector<HTMLElement>(`[data-row="${target}"]`)));
      },
    ),
  );
  // Focus stays where the reader was: on the first row a fold or "Show more" revealed.
  createEffect(
    on(focusRow, (row) => {
      if (row === undefined) return;
      queueMicrotask(() => {
        const target = body?.querySelector<HTMLElement>(`[data-row="${row}"]`);
        target?.setAttribute("tabindex", "-1");
        target?.focus({ preventScroll: false });
        setFocusRow(undefined);
      });
    }),
  );

  // ---- Line actions: one tab stop, arrow keys, Home and End move the real focus from line to line. ----
  const [stopRow, setStopRow] = createSignal<number>();
  const actionRows = createMemo(() =>
    props.lineAction ? visible().flatMap((item) => (item.type === "row" && rows()[item.index]?.kind !== "del" ? [item.index] : [])) : [],
  );
  const tabStop = () => {
    const chosen = stopRow();
    const candidates = actionRows();
    return chosen !== undefined && candidates.includes(chosen) ? chosen : candidates[0];
  };
  const locationOf = (index: number): CodeDiffLocation | undefined => {
    const row = rows()[index];
    const path = currentPath();
    return row && row.kind !== "del" && row.new !== undefined && path ? { path, line: row.new, side: "new" } : undefined;
  };
  const focusAction = (index: number) => {
    setStopRow(index);
    body?.querySelector<HTMLElement>(`[data-action-row="${index}"]`)?.focus();
  };
  const moveAction = (event: KeyboardEvent, index: number) => {
    const candidates = actionRows();
    const at = candidates.indexOf(index);
    const steps: Partial<Record<string, number>> = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: candidates.length - 1 };
    // The code itself is no tab stop while it has actions; sideways keys scroll long lines.
    const sideways: Partial<Record<string, number>> = { ArrowLeft: -48, ArrowRight: 48 };
    const step = steps[event.key];
    const scroll = sideways[event.key];
    const next = step === undefined ? undefined : candidates[Math.max(0, Math.min(candidates.length - 1, step))];
    if (next === undefined && scroll === undefined) return;
    event.preventDefault();
    if (next !== undefined) focusAction(next);
    else body?.scrollBy?.({ left: scroll, behavior: "instant" });
  };

  // A file without rows, such as one the application has not loaded yet, has nothing to summarise.
  const detail = (file: CodeDiffFile) => {
    if (file.lines.length === 0) return "";
    if (isNewFile(file)) return messages().codeDiffLines({ count: count(file.lines.length) });
    if (!hasChanges(file)) return messages().codeDiffSame;
    const added = file.lines.filter((line) => line.kind === "add").length;
    const removed = file.lines.filter((line) => line.kind === "del").length;
    return `+${count(added)} −${count(removed)}`;
  };
  // The name alone is visible; the change summary is part of the tab's name for assistive technology.
  const fileLabel = (file: CodeDiffFile) => (
    <>
      <span class="k2b-code-diff__path">{file.path}</span>
      <Show when={detail(file)}>{(summary) => <span class="k2b-sr-only">, {summary()}</span>}</Show>
    </>
  );
  // "New file" only means something beside files that have a predecessor; whole code alone is just the code.
  const comparing = createMemo(() => props.files.some((file) => file.lines.some((line) => line.kind !== "add")));
  const regionLabel = () => {
    const file = current();
    const base = props.label ?? messages().codeDiffLabel;
    if (!file) return base;
    return `${base} · ${whole() && comparing() ? messages().codeDiffNewFile({ path: file.path }) : file.path}`;
  };

  // The fixed place between the numbers and the code: the line action, and a mark while the line has content below it.
  const gutter = (index: number, location: CodeDiffLocation | undefined, noted: () => boolean) => (
    <span class="k2b-code-diff__gutter">
      <Show when={noted()}>
        <i class="ti ti-message-2 k2b-code-diff__noted" aria-hidden="true" />
      </Show>
      <Show when={props.lineAction && location}>
        {(where) => {
          const label = () => props.lineAction?.label(where()) ?? "";
          return (
            <Tooltip.Trigger
              type="button"
              class="k2b-code-diff__action"
              data-action-row={index}
              data-action-line={where().line}
              aria-label={label()}
              content={label()}
              placement="right"
              tabIndex={tabStop() === index ? 0 : -1}
              onFocus={() => setStopRow(index)}
              onClick={() => {
                setStopRow(index);
                props.lineAction?.onSelect(where());
              }}
              onKeyDown={(event) => moveAction(event, index)}
            >
              <i class="ti ti-plus" aria-hidden="true" />
            </Tooltip.Trigger>
          );
        }}
      </Show>
    </span>
  );

  const line = (index: number) => {
    const row = rows()[index]!;
    const marked = () => markIndex() === index;
    const noted = () => keep().has(index);
    const location = locationOf(index);
    return (
      <>
        <div
          class="k2b-code-diff__line"
          data-row={index}
          data-kind={whole() ? undefined : row.kind}
          data-marked={marked() ? "true" : undefined}
          data-noted={noted() ? "true" : undefined}
          aria-current={marked() ? "location" : undefined}
        >
          <Show
            when={!whole()}
            fallback={
              <>
                <span class="k2b-code-diff__number" aria-hidden="true">
                  {row.new}
                </span>
                <Show when={annotated()}>{gutter(index, location, noted)}</Show>
              </>
            }
          >
            <span class="k2b-code-diff__number" aria-hidden="true">
              {row.old}
            </span>
            <span class="k2b-code-diff__number" aria-hidden="true">
              {row.new}
            </span>
            <Show when={annotated()}>{gutter(index, location, noted)}</Show>
            <span class="k2b-code-diff__sign" aria-hidden="true">
              {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
            </span>
          </Show>
          <code>
            <Show when={marked()}>
              <span class="k2b-sr-only">{messages().codeDiffMarked} </span>
            </Show>
            <Show when={!whole() && row.kind !== "same"}>
              <span class="k2b-sr-only">
                {row.kind === "add"
                  ? messages().codeDiffAdded({ line: row.new ?? 0 })
                  : messages().codeDiffRemoved({ line: row.old ?? 0 })}{" "}
              </span>
            </Show>
            <span innerHTML={row.html || " "} />
          </code>
        </div>
        <Show when={noted() && props.lineSlot && location}>
          {/* Built once while the line stays listed; the host's content tracks its own data. */}
          <div class="k2b-code-diff__slot">{untrack(() => (location ? props.lineSlot?.(location) : undefined))}</div>
        </Show>
      </>
    );
  };

  // The body scrolls in both directions once the host gives it a height (`--k2b-code-diff-height`), so it is a stop
  // in the tab order: keyboard users scroll it like everyone else.
  const diffBody = () => (
    <div
      ref={body}
      class="k2b-code-diff__body"
      role="region"
      aria-label={regionLabel()}
      data-whole={whole() ? "true" : undefined}
      data-annotated={annotated() ? "true" : undefined}
      tabIndex={props.lineAction ? -1 : 0}
    >
      <For each={visible()}>
        {(item) =>
          item.type === "row" ? (
            line(item.index)
          ) : item.type === "note" ? (
            <p class="k2b-code-diff__note">{messages().codeDiffSameNoted}</p>
          ) : (
            <button type="button" class="k2b-code-diff__fold" data-row={item.start} onClick={() => openFold(item.start)}>
              <i class="ti ti-chevrons-down" aria-hidden="true" />
              {item.count === 1 ? messages().codeDiffUnchangedLine : messages().codeDiffUnchangedLines({ count: count(item.count) })}
            </button>
          )
        }
      </For>
      <Show when={shown() < items().length}>
        <div class="k2b-code-diff__more">
          <Button type="button" size="sm" variant="ghost" onClick={nextPage}>
            {items().length - shown() === 1
              ? messages().codeDiffMoreOne
              : messages().codeDiffMore({ count: count(Math.min(PAGE, items().length - shown())) })}
          </Button>
        </div>
      </Show>
    </div>
  );

  const loadingBody = () => (
    <div class="k2b-code-diff__body" role="status" aria-busy="true">
      <span class="k2b-sr-only">{messages().codeDiffLoading}</span>
      <For each={Array.from({ length: LOADING_ROWS })}>
        {() => (
          <div class="k2b-code-diff__line k2b-code-diff__loading">
            <Skeleton class="k2b-code-diff__skeleton" />
          </div>
        )}
      </For>
    </div>
  );

  // Loading and failure take the code's place under the file names; the surface keeps its height.
  const Content = () => (
    <Switch fallback={diffBody()}>
      <Match when={props.status === "loading"}>{loadingBody()}</Match>
      <Match when={props.status === "error"}>
        <div class="k2b-code-diff__state">
          <Placeholder
            state="error"
            icon="ti ti-cloud-off"
            title={messages().codeDiffError}
            description={props.errorDescription}
            onRetry={props.onRetry}
          />
        </div>
      </Match>
    </Switch>
  );

  // The tab panel holds the one code body: it names the file through its tab and takes keyboard focus.
  const FileTabs = () => {
    const panel = <Content />;
    return (
      <Tabs
        variant="pill"
        class="k2b-code-diff__files"
        ariaLabel={messages().codeDiffFiles}
        value={currentPath() ?? ""}
        onValueChange={choose}
        options={props.files.map((file) => ({
          value: file.path,
          label: fileLabel(file),
          panel: file.path === currentPath() ? panel : undefined,
        }))}
      />
    );
  };

  return (
    <div class={`k2b-code-diff ${props.class ?? ""}`}>
      <Show when={toolbar()}>
        <div class="k2b-code-diff__toolbar">{toolbar()}</div>
      </Show>
      <Switch>
        <Match when={props.status === undefined && !props.files.some(hasChanges) && !props.slotLines?.length}>
          <div class="k2b-code-diff__state">
            <Placeholder state="empty" icon="ti ti-equal" title={messages().codeDiffEmpty} />
          </div>
        </Match>
        <Match when={props.files.length > 1}>
          <FileTabs />
        </Match>
        <Match when={props.files.length === 1}>
          <p class="k2b-code-diff__file">{fileLabel(props.files[0]!)}</p>
          <Content />
        </Match>
        <Match when={props.files.length === 0}>
          <Content />
        </Match>
      </Switch>
    </div>
  );
}

export default CodeDiff;
