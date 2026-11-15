import { FeatCodeMark } from "@k2b/cloud/code/ui";
import { Button, ButtonLink, Paper, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import { type CodeAttentionItem, type CodeAttentionReason, type CodePlace, loadCodeAttention } from "../code-summary";
import { resolveAssistantCloudResource } from "./AssistantContextContent";
import { browserCodeInvoke } from "./code-client";
import { assistantMessages } from "./messages";

/** Code that waits for the person as an administrator of its place, each with that place as the person sees it. */
export type CodeAttentionView = { items: (CodeAttentionItem & { place: CodePlace })[]; nextCursor: string | null };

const placeOf = async (item: CodeAttentionItem): Promise<CodePlace> => {
  // An app as a whole has no page of its own here; its name comes with the server's first answer.
  if (item.owner?.kind !== "resource") return {};
  try {
    const resource = await resolveAssistantCloudResource(item.owner.ref);
    return { name: resource.name, type: resource.title, href: resource.href };
  } catch {
    return {};
  }
};

/** The browser's read of Code that needs the person, from `cursor` on, each with its place. */
export const loadCodeAttentionView = async (cursor?: string): Promise<CodeAttentionView> => {
  const page = await loadCodeAttention(browserCodeInvoke, cursor);
  return {
    items: await Promise.all(page.items.map(async (item) => ({ ...item, place: await placeOf(item) }))),
    nextCursor: page.nextCursor,
  };
};

/**
 * "Code you administer" under Waiting for you: only Code of a place that needs the person (failed, without access,
 * awaiting approval, paused). It is managed at its place, so each row leads there. The page decides when the section
 * shows; `view` null says that Core could not answer.
 */
export default function AssistantCodeAttention(props: {
  view: CodeAttentionView | null;
  more: "idle" | "loading" | "failed";
  onRetry: () => void;
  onMore: () => void;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const reasonText = (reason: CodeAttentionReason) =>
    ({
      run_failed: t().codeAttentionRunFailed,
      access_missing: t().codeAttentionAccessMissing,
      approval_pending: t().codeAttentionApproval,
      paused: t().codeAttentionPaused,
    })[reason];
  type Item = CodeAttentionView["items"][number];
  const placeName = (item: Item) => item.place.name ?? item.place.type ?? item.title;

  return (
    <section class="assistant-waiting-page__section assistant-code-attention" aria-labelledby="assistant-code-attention-title">
      <h2 id="assistant-code-attention-title" class="assistant-waiting-page__heading">
        {t().codeAttentionHeading}{" "}
        <Show when={props.view}>{(view) => <span class="assistant-waiting-page__count">{view().items.length}</span>}</Show>
      </h2>
      <Paper class="assistant-waiting-page__rows">
        <Show
          when={props.view}
          fallback={
            <div class="assistant-waiting-page__row" role="alert">
              <span class="assistant-waiting-page__tile" aria-hidden="true">
                <i class="ti ti-cloud-off" />
              </span>
              <span class="assistant-waiting-page__row-copy">
                <span class="assistant-waiting-page__row-title">{t().codeAttentionFailed}</span>
              </span>
              <Button type="button" size="sm" variant="secondary" onClick={() => props.onRetry()}>
                {t().codeViewRetry}
              </Button>
            </div>
          }
        >
          {(view) => (
            <>
              <ul class="assistant-waiting-page__list">
                <For each={view().items}>
                  {(item) => (
                    <li class="assistant-waiting-page__row">
                      <span class="assistant-waiting-page__tile" aria-hidden="true">
                        <FeatCodeMark variant="glyph" tone="current" size={16} decorative />
                      </span>
                      <span class="assistant-waiting-page__row-copy">
                        <span class="assistant-waiting-page__row-title">
                          {t().codeAttentionTitle({ place: placeName(item), reasons: item.reasons.map(reasonText).join(", ") })}
                        </span>
                        <span class="assistant-waiting-page__row-sub">
                          {t().codeAttentionSub({ title: item.title, place: placeName(item) })}
                        </span>
                      </span>
                      <Show when={item.place.href}>
                        {(href) => (
                          <ButtonLink
                            href={href()}
                            size="sm"
                            variant="secondary"
                            class="assistant-waiting-page__open"
                            aria-label={t().waitingViewLabel({ title: placeName(item) })}
                          >
                            {t().waitingView}
                          </ButtonLink>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={view().nextCursor}>
                <div class="assistant-waiting-page__row assistant-waiting-page__row--more">
                  <span class="assistant-waiting-page__row-sub">{t().codeAttentionTruncated}</span>
                  <Button type="button" size="sm" variant="ghost" loading={props.more === "loading"} onClick={() => props.onMore()}>
                    {t().codeAttentionMore}
                  </Button>
                  <Show when={props.more === "failed"}>
                    <span role="alert" class="assistant-waiting-page__failed">
                      {t().codeLoadMoreFailed}
                    </span>
                  </Show>
                </div>
              </Show>
            </>
          )}
        </Show>
      </Paper>
    </section>
  );
}
