import { createEffect, createMemo, createSignal, For, type JSX, Match, on, Show, Switch } from "solid-js";
import { Button } from "../actions/Button";
import { Tabs } from "../actions/Tabs";
import { useLocale } from "../intl/locale";
import Placeholder from "../surfaces/Placeholder";
import { Skeleton } from "../surfaces/Skeleton";
import { useCodeDiffMessages } from "./code-diff-messages";
import { type CodeDisplayLanguage, highlightCodeDisplayLines } from "./code-highlight";

/** `same` is in both versions, `add` only in the new one, `del` only in the old one. */
export type CodeDiffLineKind = "same" | "add" | "del";

export type CodeDiffLine = { kind: CodeDiffLineKind; text: string };

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
  class?: string;
};

/** Unchanged lines kept around every change; longer unchanged runs fold. */
const CONTEXT = 3;
/** Rows rendered per page; the rest waits behind "Show more", so a large file never renders at once. */
const PAGE = 400;
const LOADING_ROWS = 8;

type Row = { kind: CodeDiffLineKind; html: string; old?: number; new?: number };
type Item = { type: "row"; index: number } | { type: "fold"; start: number; count: number };

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

/** Visible rows and folds: changes with CONTEXT rows around them; unchanged runs of two or more rows fold. */
const itemsOf = (rows: readonly Row[], open: ReadonlySet<number>, whole: boolean): Item[] => {
  if (whole) return rows.map((_, index) => ({ type: "row", index }));
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
    if (distance[index]! <= CONTEXT) {
      items.push({ type: "row", index });
      index++;
      continue;
    }
    let end = index;
    while (end < rows.length && distance[end]! > CONTEXT) end++;
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
    const plain = itemsOf(rows(), opened().get(currentPath() ?? "") ?? new Set(), whole());
    const fold = plain.find((item) => item.type === "fold" && target >= item.start && target < item.start + item.count);
    return fold?.type === "fold" ? fold.start : undefined;
  });
  const items = createMemo(() => {
    const open = new Set(opened().get(currentPath() ?? ""));
    const fold = markFold();
    if (fold !== undefined) open.add(fold);
    return itemsOf(rows(), open, whole());
  });
  // Pages render cumulatively; a marked line renders the pages up to its own.
  const markPages = createMemo(() => {
    const target = markIndex();
    if (target === undefined) return 0;
    return Math.ceil((items().findIndex((item) => item.type === "row" && item.index === target) + 1) / PAGE);
  });
  const shown = createMemo(() => Math.min(items().length, Math.max(pages().get(currentPath() ?? "") ?? 1, markPages()) * PAGE));
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
    if (item) setFocusRow(item.type === "row" ? item.index : item.start);
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
  // What a mark revealed stays revealed when the mark goes away; the marked line scrolls into view.
  createEffect(
    on(
      () => [markIndex(), currentPath()] as const,
      ([target, path]) => {
        if (target === undefined || !path) return;
        const fold = markFold();
        const needed = markPages();
        if (fold !== undefined) setOpened((current) => new Map(current).set(path, new Set([...(current.get(path) ?? []), fold])));
        if (needed > (pages().get(path) ?? 1)) setPages((current) => new Map(current).set(path, needed));
        queueMicrotask(() => body?.querySelector(`[data-row="${target}"]`)?.scrollIntoView({ block: "center" }));
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

  const detail = (file: CodeDiffFile) => {
    if (isNewFile(file)) return messages().codeDiffLines({ count: count(file.lines.length) });
    if (!hasChanges(file)) return messages().codeDiffSame;
    const added = file.lines.filter((line) => line.kind === "add").length;
    const removed = file.lines.filter((line) => line.kind === "del").length;
    return `+${count(added)} −${count(removed)}`;
  };
  const fileLabel = (file: CodeDiffFile) => (
    <>
      <span class="k2b-code-diff__path">{file.path}</span>
      <span class="k2b-code-diff__detail">{detail(file)}</span>
    </>
  );
  const regionLabel = () => {
    const file = current();
    const base = props.label ?? messages().codeDiffLabel;
    if (!file) return base;
    return `${base} · ${whole() ? messages().codeDiffNewFile({ path: file.path }) : file.path}`;
  };

  const line = (index: number) => {
    const row = rows()[index]!;
    const marked = () => markIndex() === index;
    return (
      <div
        class="k2b-code-diff__line"
        data-row={index}
        data-kind={whole() ? undefined : row.kind}
        data-marked={marked() ? "true" : undefined}
        aria-current={marked() ? "location" : undefined}
      >
        <Show
          when={!whole()}
          fallback={
            <span class="k2b-code-diff__number" aria-hidden="true">
              {row.new}
            </span>
          }
        >
          <span class="k2b-code-diff__number" aria-hidden="true">
            {row.old}
          </span>
          <span class="k2b-code-diff__number" aria-hidden="true">
            {row.new}
          </span>
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
    );
  };

  const diffBody = () => (
    <div ref={body} class="k2b-code-diff__body" role="region" aria-label={regionLabel()} data-whole={whole() ? "true" : undefined}>
      <For each={visible()}>
        {(item) =>
          item.type === "row" ? (
            line(item.index)
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

  // The tab panel holds the one code body: it names the file through its tab and takes keyboard focus.
  const FileTabs = () => {
    const panel = diffBody();
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
      <Switch>
        <Match when={props.status === "loading"}>
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
        </Match>
        <Match when={props.status === "error"}>
          <Placeholder
            state="error"
            icon="ti ti-cloud-off"
            title={messages().codeDiffError}
            description={props.errorDescription}
            onRetry={props.onRetry}
          />
        </Match>
        <Match when={!props.files.some(hasChanges)}>
          <Placeholder state="empty" icon="ti ti-equal" title={messages().codeDiffEmpty} />
        </Match>
        <Match when={props.files.length > 1}>
          <FileTabs />
        </Match>
        <Match when={props.files.length === 1}>
          <p class="k2b-code-diff__file">{fileLabel(props.files[0]!)}</p>
          {diffBody()}
        </Match>
      </Switch>
    </div>
  );
}

export default CodeDiff;
