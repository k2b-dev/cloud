import { Button, Placeholder } from "@k2b/ui";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { type BlockDraftState, BlockTree } from "../../blocks/BlockTree";
import type { Block } from "../../blocks/schema";
import { readCapabilityReviewContent } from "../../capabilities/client";
import type { CapabilityReviewContentRef } from "../../contracts/capabilities";
import type { ActionCard } from "./action-card";
import { actionDetailsMessages } from "./action-details-messages";
import { actionMessages } from "./action-messages";
import { ActionTextView } from "./action-sentence";

/** A view that is not inline: it loads once, and the approval waits until it is shown complete. */
function CompleteView(props: { source: CapabilityReviewContentRef; card: ActionCard; draft?: BlockDraftState; onLoaded: () => void }) {
  const t = () => actionDetailsMessages.resolve([props.card.locale]).t;
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
            title={actionMessages(props.card.locale).fullReviewFailed}
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
  const t = () => actionDetailsMessages.resolve([props.card.locale]).t;
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
                {actionMessages(props.card.locale).openIn({ app: props.card.app.name })}
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
