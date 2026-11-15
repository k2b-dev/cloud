import { dates } from "@k2b/stdlib";
import {
  dialogCore,
  IconButton,
  isStructuredDataValue,
  LocaleProvider,
  PanelDialog,
  panelDialogOptions,
  StructuredDataPreview,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { type BlockChoiceState, BlockTree } from "../../blocks/BlockTree";
import { blockWords } from "../../blocks/messages";
import { cardToolBlocks, chartToolBlocks } from "../gustav-view-blocks";
import type { AiTurnBlock } from "../protocol";
import { useReaderTimeZone } from "./action-sentences";
import { capabilityView } from "./capability-result";
import { useAiChatActions } from "./message-actions";
import { displayToolName, isCardToolName, isChartToolName } from "./message-utils";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/**
 * Gustav as the origin of his own visuals: the same head an app's result has, with his tile in the AI colour, the kind
 * of view and the values he drew behind "Data".
 */
export const gustavOrigin = (block: ToolBlock, locale: string, title?: string) => ({
  // The head names the kind of view, as an app's head does; the chart's own title stands in its island.
  origin: {
    name: "Gustav",
    icon: "ti ti-moustache",
    accent: "var(--k2b-ai-accent)",
    title: title ?? displayToolName(block.name, locale),
  },
  data: block.args,
});

/**
 * Gustav's chart or key figure as a block with its view: the view the server stored with the result, or, while the
 * call still runs, the same translation of its arguments, so the island stands from the first frame and nothing moves
 * when the call ends. An older stored result without a view returns `undefined` and keeps the tool's own drawing.
 */
export const gustavViewBlock = (block: ToolBlock): ToolBlock | undefined => {
  if (block.isError) return undefined;
  if (block.status === "completed") return block.view ? block : undefined;
  if (block.status !== "running" || block.args === undefined) return undefined;
  const view = isChartToolName(block.name) ? chartToolBlocks(block.args) : isCardToolName(block.name) ? cardToolBlocks(block.args) : null;
  return view ? { ...block, status: "completed", view } : undefined;
};

/** Whether a view of Gustav's holds only key figures, such as a chart call of plain `stat` charts: its head says so. */
export const isKeyFigureView = (view: ToolBlock["view"]): boolean =>
  (view?.blocks.length ?? 0) > 0 &&
  (view?.blocks ?? []).every(
    (block) => block.kind === "Stats" || (block.kind === "Section" && block.children.every((child) => child.kind === "Stats")),
  );

/** Consecutive key figures as one row: one bound view with their figures, at most six to a row as the tiles allow. */
export const keyFigureGroup = (blocks: readonly ToolBlock[]): ToolBlock => {
  const items = blocks.flatMap((block) => (block.view?.blocks ?? []).flatMap((entry) => (entry.kind === "Stats" ? entry.items : [])));
  const rows = Array.from({ length: Math.ceil(items.length / 6) }, (_, index) => items.slice(index * 6, index * 6 + 6));
  return { ...blocks[0]!, view: { version: 1, blocks: rows.map((row) => ({ kind: "Stats" as const, items: row })) } };
};

/**
 * The frame of every view in the conversation: Cloud's origin line "App · Title · As of", "Open large" and "Data",
 * then the view without a hull. A capability result and Gustav's own views use it alike.
 */
export function ViewFrame(props: {
  origin: { name?: string; icon: string; accent?: string };
  title: string;
  /** When the view was made, read as day and minute in the reader's time zone. */
  at?: string;
  /** What "Open large" shows in a panel. */
  large: () => JSX.Element;
  /** What "Data" shows instead of the view. */
  data: unknown;
  children: JSX.Element;
}): JSX.Element {
  const locale = useLocale();
  const timeZone = useReaderTimeZone();
  const words = () => blockWords(locale());
  const [data, setData] = createSignal(false);
  // The same on the server and in the browser.
  const asOf = () => {
    const at = props.at ? new Date(props.at) : undefined;
    if (!at || Number.isNaN(at.getTime())) return undefined;
    const time = new Intl.DateTimeFormat(locale(), {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(at);
    return words().asOf({ time });
  };
  const openLarge = () =>
    void dialogCore.open<void>(
      (close) => (
        <LocaleProvider locale={locale()}>
          <PanelDialog>
            <PanelDialog.Header
              icon={props.origin.icon}
              title={props.title}
              subtitle={props.origin.name}
              close={close}
              closeLabel={words().close}
            />
            <PanelDialog.Body>{props.large()}</PanelDialog.Body>
          </PanelDialog>
        </LocaleProvider>
      ),
      { ...panelDialogOptions, history: true, ariaLabel: props.title },
    );
  return (
    <section class="cloud-capability-view" aria-label={props.title}>
      <div class="cloud-capability-view__head">
        <span class="cloud-capability-view__app k2b-icon-tile" style={props.origin.accent ? { color: props.origin.accent } : undefined}>
          <i class={props.origin.icon} aria-hidden="true" />
        </span>
        <strong>{props.origin.name ?? props.title}</strong>
        <Show when={props.origin.name}>
          <span class="cloud-capability-view__title">
            · {props.title}
            <Show when={asOf()}>{(stand) => <> · {stand()}</>}</Show>
          </span>
        </Show>
        <span class="cloud-capability-view__tools">
          <IconButton label={words().openLarge} size="sm" variant="ghost" onClick={openLarge}>
            <i class="ti ti-arrows-diagonal" aria-hidden="true" />
          </IconButton>
          <IconButton label={words().showData} size="sm" variant="ghost" aria-pressed={data()} onClick={() => setData(!data())}>
            <i class="ti ti-braces" aria-hidden="true" />
          </IconButton>
        </span>
      </div>
      <Show when={data() && isStructuredDataValue(props.data) ? props.data : undefined} fallback={props.children}>
        {(value) => <StructuredDataPreview data={value()} />}
      </Show>
    </section>
  );
}

/**
 * A capability result as the person sees it: Cloud's origin line "App · Title" and the app's blocks in the flow of the
 * conversation, without a hull. "Open large" shows the same blocks in a panel; the data toggle shows what Gustav read.
 */
export function CapabilityViewBlock(props: {
  block: ToolBlock;
  turnId: string;
  /** The response that produced the result still runs: an open choice waits until it ends. */
  live: boolean;
  /** Who shows it when no app does, such as Gustav for his own charts; the title names the view. */
  origin?: { name: string; icon: string; accent?: string; title: string };
  /** What "Data" shows instead of the result, such as the values Gustav drew. */
  data?: unknown;
}): JSX.Element {
  const locale = useLocale();
  const timeZone = useReaderTimeZone();
  const actions = useAiChatActions();
  const app = () =>
    props.origin
      ? { appName: props.origin.name, appIcon: props.origin.icon, appAccent: props.origin.accent, title: props.origin.title }
      : props.block.presentation;
  const title = () => app()?.title ?? displayToolName(props.block.name, locale());
  // Cloud keeps the state of the view's choice: answered and superseded stay read-only after a reload too.
  const choice = createMemo((): BlockChoiceState | undefined => {
    const stored = props.block.choice;
    if (!stored) return undefined;
    const submit = actions.onChoice;
    return {
      state: stored.state === "open" && (props.live || !submit) ? "busy" : stored.state,
      chosen: stored.chosen,
      answeredAt: stored.answeredAt ? dates.formatTime(stored.answeredAt, { locale: locale(), timeZone }) : undefined,
      submit: submit ? (blockId, ids) => submit({ turnId: props.turnId, toolCallId: props.block.callId }, blockId, ids) : undefined,
    };
  });
  return (
    <Show when={capabilityView(props.block)}>
      {(view) => (
        <ViewFrame
          origin={{ name: app()?.appName, icon: app()?.appIcon ?? "ti ti-apps", accent: app()?.appAccent }}
          title={title()}
          at={props.block.at}
          large={() => <BlockTree blocks={view().blocks} host="result" locale={locale()} timeZone={timeZone} />}
          data={props.data ?? props.block.result}
        >
          <BlockTree blocks={view().blocks} host="result" locale={locale()} timeZone={timeZone} choice={choice()} />
        </ViewFrame>
      )}
    </Show>
  );
}
