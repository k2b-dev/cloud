import { Button, Chat, type ChatOutcomeLine, LocaleProvider, Placeholder, ReferenceChip } from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { type BlockDraftState, BlockTree } from "../../blocks/BlockTree";
import type { Block } from "../../blocks/schema";
import { readCapabilityReviewContent } from "../../capabilities/client";
import type { CapabilityReviewContentRef } from "../../contracts/capabilities";
import type { ActionCard, ActionChip, ActionText } from "./action-card";
import { actionMessages } from "./action-messages";

/**
 * The words and details of an Action approval and its outcome lines: one sentence with chips, Cloud's list of what
 * changes, the app's view blocks, and after the answer one outcome line in the same place. `ApprovalCard` draws them in
 * every place from an `ActionCard`.
 */

// ---------------------------------------------------------------------------
// Sentence
// ---------------------------------------------------------------------------

function PersonChips(props: { chip: Extract<ActionChip, { kind: "person" }> }) {
  // List words such as ", " and " und " come from the locale; each name is its own chip, the rest stays text.
  const parts = createMemo(() => {
    const names = props.chip.names;
    const items =
      props.chip.rest > 0 ? [...names.map((_, index) => `\u0000${index}`), props.chip.more] : names.map((_, index) => `\u0000${index}`);
    return new Intl.ListFormat(props.chip.locale, { type: "conjunction" }).formatToParts(items).map((part) => {
      const match = part.type === "element" ? /^\u0000(\d+)$/.exec(part.value) : null;
      return match ? { name: names[Number(match[1])]! } : { text: part.value };
    });
  });
  return <For each={parts()}>{(part) => ("name" in part ? <ReferenceChip kind="person" name={part.name ?? ""} /> : part.text)}</For>;
}

const personChip = (chip: ActionChip) => (chip.kind === "person" ? chip : undefined);
const timeChip = (chip: ActionChip) => (chip.kind === "time" ? chip : undefined);
const thingChip = (chip: ActionChip) => (chip.kind === "object" || chip.kind === "place" ? chip : undefined);

/** A sentence of text and typed chips, in the app's colour. */
export function ActionTextView(props: { text: ActionText; accent?: string }) {
  return (
    <For each={props.text}>
      {(part) => (
        <Switch fallback={part.kind === "text" ? part.text : null}>
          <Match when={part.kind === "chip" ? part.chip : undefined}>
            {(chip) => (
              <Switch>
                <Match when={personChip(chip())}>{(person) => <PersonChips chip={person()} />}</Match>
                <Match when={timeChip(chip())}>
                  {(time) => <ReferenceChip kind="time" label={time().label} dateTime={time().dateTime} />}
                </Match>
                <Match when={thingChip(chip())}>
                  {(thing) => (
                    <ReferenceChip
                      kind={thing().kind}
                      title={thing().title}
                      href={thing().href}
                      icon={thing().icon}
                      accent={props.accent}
                      gone={thing().gone}
                    />
                  )}
                </Match>
              </Switch>
            )}
          </Match>
        </Switch>
      )}
    </For>
  );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/** A view that is not inline: it loads once, and the approval waits until it is shown complete. */
function CompleteView(props: { source: CapabilityReviewContentRef; card: ActionCard; draft?: BlockDraftState; onLoaded: () => void }) {
  const t = () => actionMessages(props.card.locale);
  const [blocks, setBlocks] = createSignal<Block[]>();
  const [failed, setFailed] = createSignal(false);
  let request: AbortController | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    request?.abort();
  });
  const load = async () => {
    if (disposed) return;
    request?.abort();
    request = new AbortController();
    setFailed(false);
    const result = await readCapabilityReviewContent(props.source, { signal: request.signal });
    if (disposed) return;
    if (!result.ok) return setFailed(true);
    setBlocks(result.data.blocks);
    props.onLoaded();
  };
  onMount(() => void load());
  return (
    <Show
      when={blocks()}
      fallback={
        <Show when={failed()} fallback={<Placeholder state="loading" title={t().fullReviewLoading} variant="inline" />}>
          <Placeholder
            state="error"
            title={t().fullReviewFailed}
            variant="inline"
            action={
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                {t().fullReviewRetry}
              </Button>
            }
          />
        </Show>
      }
    >
      {(view) => <BlockTree blocks={view()} host="review" locale={props.card.locale} timeZone={props.card.timeZone} draft={props.draft} />}
    </Show>
  );
}

/**
 * What the approval is about: Cloud's sentences on what changes, the app's view blocks, and the review's links such as
 * editing the draft in its app. A view too large to travel inline loads first; `onContentLoaded` says when it is shown.
 */
export function ActionDetails(props: { card: ActionCard; draft?: BlockDraftState; onContentLoaded?: (key: string) => void }): JSX.Element {
  const t = () => actionMessages(props.card.locale);
  return (
    <div class="cloud-action-details">
      <Show when={(props.card.consequences ?? []).length > 0}>
        <section class="cloud-action-details__changes" aria-label={t().changes}>
          <p class="cloud-action-details__label">{t().changes}</p>
          <ul>
            <For each={props.card.consequences}>
              {(line) => (
                <li data-mark={line.mark}>
                  <i
                    class={line.mark === "removed" ? "ti ti-minus" : line.mark === "added" ? "ti ti-plus" : "ti ti-point"}
                    aria-hidden="true"
                  />
                  <span>
                    <ActionTextView text={line.text} accent={props.card.app.accent} />
                  </span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show
        when={props.card.contentRef}
        fallback={
          <Show when={props.card.view}>
            {(view) => (
              <BlockTree blocks={view()} host="review" locale={props.card.locale} timeZone={props.card.timeZone} draft={props.draft} />
            )}
          </Show>
        }
      >
        {(source) => (
          <CompleteView
            source={source()}
            card={props.card}
            draft={props.draft}
            onLoaded={() => props.onContentLoaded?.(`${source().href}:${source().digest}`)}
          />
        )}
      </Show>
      <Show when={props.card.links.length > 0 || props.card.readMore}>
        <p class="cloud-action-details__links">
          <Show when={props.card.readMore}>
            {(href) => (
              <a href={href()} target="_blank" rel="noopener noreferrer" title={t().readMoreTitle}>
                {t().readMore}
              </a>
            )}
          </Show>
          <For each={props.card.links}>
            {(link) => (
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
            )}
          </For>
        </p>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** One outcome line: what happened, in the card's sentence, with Cloud's detail under it. */
export type ActionLine = Omit<ChatOutcomeLine, "text" | "detail"> & { text: ActionText; detail?: JSX.Element };

/**
 * The outcome line of one call. Pass every line one flow can reach (running and done, or the lines of a check): they
 * share one cell, so switching between them moves nothing.
 */
export function ActionReceipt(props: {
  card: ActionCard;
  lines: Readonly<Record<string, ActionLine>>;
  current: string;
  class?: string;
  anchorId?: string | number;
}) {
  const lines = createMemo(() =>
    Object.fromEntries(
      Object.entries(props.lines).map(([key, line]) => [
        key,
        { ...line, text: <ActionTextView text={line.text} accent={props.card.app.accent} /> } satisfies ChatOutcomeLine,
      ]),
    ),
  );
  return (
    <LocaleProvider locale={props.card.locale}>
      <Chat.Outcome class={`cloud-action-outcome ${props.class ?? ""}`} lines={lines()} current={props.current} anchorId={props.anchorId} />
    </LocaleProvider>
  );
}
