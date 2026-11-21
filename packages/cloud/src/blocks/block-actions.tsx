import { IconButton, Lightbox, type LightboxItem, toast, useLocale } from "@k2b/ui";
import { createContext, createMemo, createSignal, type JSX, onCleanup, Show, useContext } from "solid-js";
import { type BlockCopy, writeBlockCopy } from "./block-copy";
import { blockWords } from "./messages";

/**
 * What a block's frame knows and the block itself does not: who made it (Gustav or an app), when, and the data behind
 * it. A chat answer's frame passes it to every block inside, of any origin; a block outside a frame shows no actions.
 */
export type BlockFrame = { origin: string; asOf?: string; data?: unknown };
const FrameContext = createContext<BlockFrame>();
export const BlockFrameProvider = FrameContext.Provider;
export const useBlockFrame = () => useContext(FrameContext);

/** A block drawn inside the Lightbox is already large: it keeps Copy and leaves out Maximize. */
const LargeContext = createContext(false);
export const useBlockIsLarge = () => useContext(LargeContext);

export type BlockKind = "table" | "chart" | "figures";
type Entry = {
  anchor: () => Element | undefined;
  name: () => string;
  kind: BlockKind;
  frame: BlockFrame;
  content: () => JSX.Element;
  copy: () => BlockCopy | Promise<BlockCopy>;
  download?: () => void | Promise<void>;
};
type Answer = { register: (entry: Entry) => () => void; open: (entry: Entry) => void };
const AnswerContext = createContext<Answer>();

const before = (a: Entry, b: Entry) => {
  const x = a.anchor();
  const y = b.anchor();
  if (!x || !y || x === y) return 0;
  return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
};

/** Copies with feedback: a check for 1.5 s at the same place and "Copied" for a screen reader; a failure says so. */
const copyWithFeedback = (copy: Entry["copy"], words: ReturnType<typeof blockWords>, done?: () => void) => {
  const run = (): Promise<void> =>
    writeBlockCopy(copy())
      .then(() => done?.())
      .catch(() => {
        toast.error(words.copyFailed, { action: { label: words.tryAgain, onClick: () => void run() } });
      });
  return run();
};

/**
 * The blocks of one answer. Each block registers itself; Maximize opens the Lightbox over all of them in the order they
 * stand, so ← and → step from the table to the chart. Mixed origins are fine: every entry keeps its own frame.
 */
export function AnswerBlocks(props: { children: JSX.Element }) {
  const locale = useLocale();
  const words = () => blockWords(locale());
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [shown, setShown] = createSignal<Entry | null>(null);
  const [raw, setRaw] = createSignal(false);
  // Copy in the Lightbox answers as in the block's head: a check for 1.5 s in the same place, "Copied" for a screen reader.
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));
  // The order the blocks stand in, read when the Lightbox opens: a block registers while it is built, before its anchor
  // is in the page, so an order read then is the order the blocks happened to load (in WebKit a late table came last).
  const ordered = createMemo(() => (shown() ? entries().toSorted(before) : []));
  const answer: Answer = {
    register: (entry) => {
      setEntries((list) => [...list, entry]);
      return () => {
        setEntries((list) => list.filter((item) => item !== entry));
        if (shown() === entry) setShown(null);
      };
    },
    open: (entry) => {
      setRaw(false);
      setShown(() => entry);
    },
  };
  const kindWord = (kind: BlockKind) => (kind === "table" ? words().kindTable : kind === "chart" ? words().kindChart : words().kindFigures);
  // One item per block for as long as it stands: the Lightbox keeps a shown item's content mounted (its search, its
  // scroll) while only its actions change, through the getters below.
  const itemOf = new WeakMap<Entry, LightboxItem>();
  const item = (entry: Entry): LightboxItem => {
    const known = itemOf.get(entry);
    if (known) return known;
    const created: LightboxItem = {
      get name() {
        return entry.name();
      },
      get meta() {
        return [entry.frame.origin, kindWord(entry.kind), entry.frame.asOf].filter(Boolean).join(" · ");
      },
      content: () => (
        <>
          <span class="sr-only" role="status">
            {copied() && entry === shown() ? words().copied : ""}
          </span>
          <Show when={raw() && entry === shown()} fallback={<LargeContext.Provider value={true}>{entry.content()}</LargeContext.Provider>}>
            <section class="cloud-block-raw" aria-label={words().rawData}>
              <header class="cloud-block-raw__head">
                <strong>{words().rawData}</strong>
                <span>{words().readOnly}</span>
              </header>
              <pre>{JSON.stringify(entry.frame.data ?? null, null, 2)}</pre>
            </section>
          </Show>
        </>
      ),
      get actions() {
        return [
          { label: words().rawData, icon: "ti ti-braces", onClick: () => setRaw(!raw()) },
          {
            // The label stays, so the pill keeps its width; the sign turns into a check.
            label: words().copy,
            icon: copied() && entry === shown() ? "ti ti-check" : "ti ti-copy",
            onClick: () =>
              void copyWithFeedback(
                raw() ? () => ({ text: JSON.stringify(entry.frame.data ?? null, null, 2) }) : entry.copy,
                words(),
                () => {
                  setCopied(true);
                  clearTimeout(copiedTimer);
                  copiedTimer = setTimeout(() => setCopied(false), 1_500);
                },
              ),
          },
        ];
      },
      ...(entry.download ? { onDownload: () => void entry.download?.() } : {}),
    };
    itemOf.set(entry, created);
    return created;
  };
  const items = createMemo(() => ordered().map(item));
  const index = () => Math.max(0, ordered().indexOf(shown() as Entry));
  return (
    <AnswerContext.Provider value={answer}>
      {props.children}
      <Show when={shown()}>
        <Lightbox
          items={items()}
          index={index()}
          onIndexChange={(next) => {
            setRaw(false);
            setCopied(false);
            setShown(() => ordered()[next] ?? null);
          }}
          onClose={() => setShown(null)}
        />
      </Show>
    </AnswerContext.Provider>
  );
}

/**
 * Copy and Maximize of one block, in its head (table, chart) or at the end of its row (key figures). Shown only inside a
 * frame; inside the Lightbox only Copy. Both keep their place and size whatever they show.
 */
export function BlockActions(props: {
  kind: BlockKind;
  /** The block's own title: the Lightbox's name. */
  name: string;
  /** What Copy puts on the clipboard; `root` is the block around the actions. */
  copy: (root: Element | undefined) => BlockCopy | Promise<BlockCopy>;
  download?: (root: Element | undefined) => void | Promise<void>;
  /** The block itself, drawn large. */
  content: () => JSX.Element;
  /** Key figures: quiet until pointed at or focused on a computer, always on touch. */
  quiet?: boolean;
}): JSX.Element {
  const frame = useBlockFrame();
  const answer = useContext(AnswerContext);
  return (
    <Show when={frame}>
      {(known) => (
        <Show when={answer} fallback={<AnswerBlocks>{<Actions {...props} frame={known()} />}</AnswerBlocks>}>
          <Actions {...props} frame={known()} />
        </Show>
      )}
    </Show>
  );
}

function Actions(props: Parameters<typeof BlockActions>[0] & { frame: BlockFrame }) {
  const locale = useLocale();
  const words = () => blockWords(locale());
  const answer = useContext(AnswerContext);
  const large = useBlockIsLarge();
  const [copied, setCopied] = createSignal(false);
  let root: HTMLSpanElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  // The block around the actions: a table's frame or section, a row of key figures, a chart's explorer.
  const block = () => root?.closest(".cloud-block-figures, .k2b-chart-explorer, .k2b-dashboard-frame, section") ?? undefined;
  const entry: Entry = {
    anchor: () => root,
    name: () => props.name,
    kind: props.kind,
    frame: props.frame,
    content: () => props.content(),
    copy: () => props.copy(block()),
    ...(props.download ? { download: () => props.download?.(block()) } : {}),
  };
  if (answer && !large) onCleanup(answer.register(entry));
  const copyLabel = () =>
    copied()
      ? words().copied
      : props.kind === "table"
        ? words().copyTable
        : props.kind === "chart"
          ? words().copyChart
          : words().copyFigures;
  const copy = () =>
    void copyWithFeedback(entry.copy, words(), () => {
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1_500);
    });
  return (
    <span ref={root} class="cloud-block-actions" data-quiet={props.quiet ? "" : undefined}>
      <IconButton size="sm" variant="ghost" label={copyLabel()} onClick={copy} data-copied={copied() ? "" : undefined}>
        <i class={copied() ? "ti ti-check" : "ti ti-copy"} aria-hidden="true" />
      </IconButton>
      <Show when={!large && answer}>
        <IconButton size="sm" variant="ghost" label={words().maximize} onClick={() => answer?.open(entry)}>
          <i class="ti ti-arrows-maximize" aria-hidden="true" />
        </IconButton>
      </Show>
      <span class="sr-only" role="status">
        {copied() ? words().copied : ""}
      </span>
    </span>
  );
}

/**
 * The quiet line under a searchable table in an answer: what the search finds, else how many rows the table has (or
 * `idle`, such as how many of them it shows). It keeps its line in every state, so a search never moves the answer.
 */
export function BlockFoot(props: { query: string; shown: number; total: number; idle?: string }) {
  const locale = useLocale();
  const words = () => blockWords(locale());
  return (
    <p class="cloud-block-foot" role="status">
      {props.query ? words().matches({ count: props.shown }) : (props.idle ?? words().rowCount({ count: props.total }))}
    </p>
  );
}
