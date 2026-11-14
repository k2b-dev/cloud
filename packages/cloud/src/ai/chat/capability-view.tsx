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
import type { AiTurnBlock } from "../protocol";
import { useReaderTimeZone } from "./action-sentences";
import { capabilityView } from "./capability-result";
import { useAiChatActions } from "./message-actions";
import { displayToolName } from "./message-utils";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/**
 * A capability result as the person sees it: Cloud's origin line "App · Title" and the app's blocks in the flow of the
 * conversation, without a hull. "Open large" shows the same blocks in a panel; the data toggle shows what Gustav read.
 */
export function CapabilityViewBlock(props: {
  block: ToolBlock;
  turnId: string;
  /** The response that produced the result still runs: an open choice waits until it ends. */
  live: boolean;
}): JSX.Element {
  const locale = useLocale();
  const timeZone = useReaderTimeZone();
  const actions = useAiChatActions();
  const words = () => blockWords(locale());
  const [data, setData] = createSignal(false);
  const app = () => props.block.presentation;
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
  const tree = (view: NonNullable<ReturnType<typeof capabilityView>>) => (
    <BlockTree blocks={view.blocks} host="result" locale={locale()} timeZone={timeZone} choice={choice()} />
  );
  const openLarge = (view: NonNullable<ReturnType<typeof capabilityView>>) =>
    void dialogCore.open<void>(
      (close) => (
        <LocaleProvider locale={locale()}>
          <PanelDialog>
            <PanelDialog.Header
              icon={app()?.appIcon ?? "ti ti-apps"}
              title={title()}
              subtitle={app()?.appName}
              close={close}
              closeLabel={words().close}
            />
            <PanelDialog.Body>
              <BlockTree blocks={view.blocks} host="result" locale={locale()} timeZone={timeZone} />
            </PanelDialog.Body>
          </PanelDialog>
        </LocaleProvider>
      ),
      { ...panelDialogOptions, history: true, ariaLabel: title() },
    );
  return (
    <Show when={capabilityView(props.block)}>
      {(view) => (
        <section class="cloud-capability-view" aria-label={title()}>
          <div class="cloud-capability-view__head">
            <span class="cloud-capability-view__app k2b-icon-tile" style={app()?.appAccent ? { color: app()!.appAccent } : undefined}>
              <i class={app()?.appIcon ?? "ti ti-apps"} aria-hidden="true" />
            </span>
            <strong>{app()?.appName ?? title()}</strong>
            <Show when={app()?.appName}>
              <span class="cloud-capability-view__title">· {title()}</span>
            </Show>
            <span class="cloud-capability-view__tools">
              <IconButton label={words().openLarge} size="sm" variant="ghost" onClick={() => openLarge(view())}>
                <i class="ti ti-arrows-diagonal" aria-hidden="true" />
              </IconButton>
              <IconButton label={words().showData} size="sm" variant="ghost" aria-pressed={data()} onClick={() => setData(!data())}>
                <i class="ti ti-braces" aria-hidden="true" />
              </IconButton>
            </span>
          </div>
          <Show when={data() && isStructuredDataValue(props.block.result) ? props.block.result : undefined} fallback={tree(view())}>
            {(result) => <StructuredDataPreview data={result()} />}
          </Show>
        </section>
      )}
    </Show>
  );
}
