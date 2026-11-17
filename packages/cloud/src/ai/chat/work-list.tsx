import { Chat, useLocale } from "@k2b/ui";
import { createMemo, For, Match, Show, Switch, untrack } from "solid-js";
import { markdown } from "../../shared";
import type { AiTurnBlock } from "../protocol";
import { CompactionBlockView, CompactToolRow } from "./blocks";
import { aiToolIcon, displayToolName } from "./message-utils";
import { aiChatMessages } from "./messages";
import { AssistantMarkdownBlock } from "./primitives";
import { AiToolActivity } from "./tool-disclosure";
import { type AiWorkEntry, type AiWorkItem, countWorkSteps, groupWorkBlocks } from "./tool-groups";
import { AiNoteStep, AiThoughtStep, AiWorkContext, type AiWorkContextValue, AiWorkStep, keepsStepDetail } from "./work-steps";

/**
 * The opened work of a turn: its steps as one-line rows. The work line loads this module when it appears in the
 * browser (`#chat-work-list`), so the steps' code leaves the island's first JavaScript; the server renders it eagerly.
 */

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

function WorkEntryRow(props: { entry: AiWorkEntry; busy: boolean }) {
  const locale = useLocale();
  return (
    <Switch>
      <Match when={props.entry.kind === "tool" && keepsStepDetail(props.entry.name) && props.entry}>
        {(tool) => <CompactToolRow block={tool()} busy={props.busy} />}
      </Match>
      <Match when={props.entry.kind === "tool" && props.entry}>{(tool) => <AiWorkStep block={tool()} busy={props.busy} />}</Match>
      <Match when={props.entry.kind === "thinking" && props.entry}>
        {(thought) => <AiThoughtStep block={thought()} busy={props.busy} />}
      </Match>
      <Match when={props.entry.kind === "compaction" && props.entry}>{(compaction) => <CompactionBlockView block={compaction()} />}</Match>
      <Match when={props.entry.kind === "steer_applied"}>
        <Chat.Activity label={aiChatMessages(locale()).steered} icon="ti ti-route" />
      </Match>
    </Switch>
  );
}

/** The steps of an opened group, keyed by block id, so a row keeps its element and focus when its block is replaced. */
function WorkEntries(props: { entries: AiWorkEntry[]; active: boolean }) {
  const entries = createMemo(() => new Map(props.entries.map((entry) => [entry.id, entry])));
  const ids = createMemo(() => [...entries().keys()]);
  return (
    <div class="ai-turn-steps">
      <For each={ids()}>
        {(id, index) => (
          <Show when={entries().get(id)}>
            {(entry) => <WorkEntryRow entry={entry()} busy={props.active && index() === ids().length - 1} />}
          </Show>
        )}
      </For>
    </div>
  );
}

/**
 * Housekeeping folded into one row at step level, with its count at the end like the work line's. It opens in place:
 * its steps follow at the same indent.
 */
function HousekeepingGroup(props: { id: string; entries: AiWorkEntry[]; active: boolean }) {
  const locale = useLocale();
  const last = () => props.entries.at(-1)!;
  return (
    <AiToolActivity
      blockId={`group:${props.id}`}
      label={aiChatMessages(locale()).groupLoad}
      meta={countWorkSteps(props.entries, locale())}
      icon="ti ti-stack-2"
      busy={props.active && last().kind === "tool" && (last() as ToolBlock).status === "running"}
      renderBody={() => <WorkEntries entries={props.entries} active={props.active} />}
    />
  );
}

/**
 * Consecutive instances of one call apart from paging, such as reading one file in parts, folded into one row that
 * opens in place. Its count sits at the end like the work line's, so a narrow screen cuts the target short, never the count.
 */
function RepeatedSteps(props: { id: string; target: string; entries: AiWorkEntry[]; active: boolean }) {
  const locale = useLocale();
  const tools = () => props.entries.filter((entry): entry is ToolBlock => entry.kind === "tool");
  const first = () => tools()[0]!;
  return (
    <AiToolActivity
      blockId={`repeat:${props.id}`}
      label={first().presentation?.title ?? displayToolName(first().name, locale())}
      // The file of a path; a row never shows a path.
      description={props.target.slice(props.target.lastIndexOf("/") + 1) || props.target}
      meta={aiChatMessages(locale()).repeatCount({ count: tools().length })}
      icon={aiToolIcon(first().name, first().presentation?.appIcon)}
      accent={first().presentation?.appAccent}
      busy={props.active && tools().at(-1)?.status === "running"}
      renderBody={() => <WorkEntries entries={props.entries} active={props.active} />}
    />
  );
}

/**
 * What Gustav wrote between two steps: a step of its own, "Thought it over", with the whole text in its card, where a
 * long text scrolls. The opened work stays a list of one-line steps.
 */
function WorkNote(props: { text: string }) {
  const locale = useLocale();
  // Render Markdown only when the text itself changes, not on every update of the turn around it.
  const text = createMemo(() => props.text);
  const html = createMemo(() => markdown.renderSync(text(), { locale: locale() }));
  return (
    <AiNoteStep label={aiChatMessages(locale()).stepThought} busy={false}>
      <AssistantMarkdownBlock html={html()} />
    </AiNoteStep>
  );
}

const workItemKey = (item: AiWorkItem): string =>
  item.kind === "text"
    ? `text:${item.block.id}`
    : item.kind === "step"
      ? `step:${item.entry.id}`
      : item.kind === "repeat"
        ? `repeat:${item.id}`
        : `group:${item.id}`;

/** On opening, a long list shows its newest rows; the earlier ones wait behind one row in the same form. */
const AI_WORK_SHOWN_ROWS = 6;

/** One row of the opened work: a step, a note, or a folded group, keyed so it keeps its element while it updates. */
function WorkItemRow(props: { item: AiWorkItem | undefined; active: boolean }) {
  const text = () => (props.item?.kind === "text" ? props.item.block.text : undefined);
  const step = () => (props.item?.kind === "step" ? props.item.entry : undefined);
  const group = () => (props.item?.kind === "housekeeping" ? props.item : undefined);
  const repeat = () => (props.item?.kind === "repeat" ? props.item : undefined);
  return (
    <Switch>
      <Match when={text()}>{(value) => <WorkNote text={value()} />}</Match>
      <Match when={step()}>{(entry) => <WorkEntryRow entry={entry()} busy={props.active} />}</Match>
      <Match when={group()}>{(value) => <HousekeepingGroup id={value().id} entries={value().entries} active={props.active} />}</Match>
      <Match when={repeat()}>
        {(value) => <RepeatedSteps id={value().id} target={value().target} entries={value().entries} active={props.active} />}
      </Match>
    </Switch>
  );
}

/**
 * Expanded work, at the work line's edge and on its grid: one row per step, Gustav's notes as steps of their own, and
 * housekeeping or repeated steps folded into groups that open in place. A row shown while this list is open never
 * folds away under the reader, also when reasoning or arguments that would fold it arrive later; the next time it
 * opens, it folds like in history. A long list opens on its newest rows, after one row "Show n earlier steps"; while
 * it is open it only grows, and that row stays as it was.
 */
export function AiWorkSteps(props: { blocks: AiTurnBlock[]; active: boolean; work: AiWorkContextValue }) {
  const locale = useLocale();
  const shown = new Set<string>();
  let root: HTMLDivElement | undefined;
  const items = createMemo(() => {
    const work = groupWorkBlocks(props.blocks, shown);
    // Finishing replaces live rows with stored rows. Hand focus back before that replacement disposes an open card.
    if (!props.active) {
      const focused = root?.ownerDocument.activeElement;
      if (focused?.hasAttribute("data-ai-live-detail") && root?.contains(focused))
        root.closest(".ai-turn-work")?.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
    }
    for (const item of work) if (item.kind === "step") shown.add(item.entry.id);
    return new Map(work.map((item) => [workItemKey(item), item]));
  });
  const keys = createMemo(() => [...items().keys()]);
  // Taken once, when the list opens, by identity: a row that joins the list later never hides among them.
  const hidden = new Set(untrack(() => keys().slice(0, Math.max(0, keys().length - AI_WORK_SHOWN_ROWS))));
  const earlier = hidden.size;
  const row = (key: string) => <WorkItemRow item={items().get(key)} active={props.active && key === keys().at(-1)} />;
  return (
    <AiWorkContext.Provider value={props.work}>
      <div ref={root} class="ai-turn-steps">
        <Show when={earlier > 0}>
          <Chat.Activity
            class="ai-turn-steps__earlier"
            icon="ti ti-history"
            label={aiChatMessages(locale()).stepsEarlier({ count: earlier })}
            bodyInset={false}
            renderBody={() => (
              <div class="ai-turn-steps">
                <For each={keys().filter((key) => hidden.has(key))}>{row}</For>
              </div>
            )}
          />
        </Show>
        <For each={keys().filter((key) => !hidden.has(key))}>{row}</For>
      </div>
    </AiWorkContext.Provider>
  );
}
