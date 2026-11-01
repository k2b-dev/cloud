import { Button, ButtonLink, useLocale } from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import { type CodeAttentionItem, type CodeAttentionReason, type CodePlace, loadCodeAttention } from "../code-summary";
import { resolveAssistantCloudResource } from "./AssistantContextContent";
import { browserCodeInvoke } from "./code-client";
import { assistantMessages } from "./messages";

/** Code that waits for the person as an administrator of its place, each with that place as the person sees it. */
export type CodeAttentionView = { items: (CodeAttentionItem & { place: CodePlace })[]; truncated: boolean };

const placeOf = async (item: CodeAttentionItem): Promise<CodePlace> => {
  if (!item.owner) return {};
  try {
    const resource = await resolveAssistantCloudResource(item.owner);
    return { name: resource.name, type: resource.title, href: resource.href };
  } catch {
    return {};
  }
};

/**
 * "Code you administer" under Waiting for you: only Code of a place that needs the person (failed, without access,
 * paused). It is managed at its place, so each row leads there. Nothing shows when nothing waits.
 * `initial` is the server's answer (null when Core could not answer); without it, the list loads in the browser.
 */
export default function AssistantCodeAttention(props: { initial?: CodeAttentionView | null }) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const [view, setView] = createSignal<CodeAttentionView | null | undefined>(props.initial);
  const load = async () => {
    setView(undefined);
    try {
      const page = await loadCodeAttention(browserCodeInvoke);
      const items = await Promise.all(page.items.map(async (item) => ({ ...item, place: await placeOf(item) })));
      setView({ items, truncated: page.truncated });
    } catch {
      setView(null);
    }
  };
  onMount(() => {
    if (props.initial === undefined) void load();
  });
  const reasonText = (reason: CodeAttentionReason) =>
    ({ run_failed: t().codeAttentionRunFailed, access_removed: t().codeAttentionAccessRemoved, paused: t().codeAttentionPaused })[reason];
  const placeName = (item: CodeView) => item.place.name ?? item.place.type ?? item.title;
  type CodeView = CodeAttentionView["items"][number];

  return (
    <Show when={view() === null || (view()?.items.length ?? 0) > 0}>
      <section class="assistant-code-attention" aria-labelledby="assistant-code-attention-title">
        <h2 id="assistant-code-attention-title" class="assistant-code-attention__heading">
          {t().codeAttentionHeading}
        </h2>
        <Show
          when={view()}
          fallback={
            <div class="assistant-code-attention__row" role="alert">
              <span class="assistant-code-attention__tile" aria-hidden="true">
                <i class="ti ti-cloud-off" />
              </span>
              <span class="min-w-0 text-primary">{t().codeAttentionFailed}</span>
              <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {t().codeBlockRetry}
              </Button>
            </div>
          }
        >
          {(current) => (
            <>
              <ul class="assistant-code-attention__list">
                <For each={current().items}>
                  {(item) => (
                    <li class="assistant-code-attention__row">
                      <span class="assistant-code-attention__tile" aria-hidden="true">
                        <i class="ti ti-code" />
                      </span>
                      <span class="flex min-w-0 flex-col">
                        <span class="text-primary">
                          {t().codeAttentionTitle({ place: placeName(item), reasons: item.reasons.map(reasonText).join(", ") })}
                        </span>
                        <span class="text-sm text-secondary">{t().codeAttentionSub({ title: item.title, place: placeName(item) })}</span>
                      </span>
                      <Show when={item.place.href}>
                        {(href) => (
                          <ButtonLink href={href()} size="sm" variant="secondary" class="assistant-code-attention__open">
                            <i class="ti ti-arrow-right" aria-hidden="true" />
                            {t().codeOpenPlace({ type: item.place.type ?? "" })}
                          </ButtonLink>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={current().truncated}>
                <p class="text-sm text-secondary">{t().codeAttentionTruncated}</p>
              </Show>
            </>
          )}
        </Show>
        <p class="max-w-[40rem] text-sm text-secondary">{t().codeAttentionNote}</p>
      </section>
    </Show>
  );
}
